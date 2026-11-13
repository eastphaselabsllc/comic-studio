import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import fs from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {startMockGateway} from './mock-gateway.js';

const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const port=4175;
const origin=`http://127.0.0.1:${port}`;
const profile='/tmp/cs-swap-chrome';
fs.rmSync(profile,{recursive:true,force:true});
await mkdir('/opt/cursor/artifacts',{recursive:true});
const gw=await startMockGateway('browser-swap-token');
const server=spawn('python3',['-m','http.server',String(port),'--bind','127.0.0.1'],{cwd:'/workspace',stdio:'ignore'});
const chrome=spawn('google-chrome',[
  '--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
  '--remote-debugging-port=9336',`--user-data-dir=${profile}`,'about:blank'
],{stdio:'ignore'});
const logs=[];
let ws,sessionId;

async function json(path){
  const res=await fetch(`http://127.0.0.1:9336${path}`);
  if(!res.ok)throw Error(path+' '+res.status);
  return res.json();
}
try{
  let version;
  for(let i=0;i<50;i++){try{version=await json('/json/version');break;}catch{await delay(100);}}
  if(!version)throw Error('Chrome did not open a debugging port');
  for(let i=0;i<50;i++){try{const ping=await fetch(origin+'/');if(ping.ok)break;}catch{await delay(100);}if(i===49)throw Error('app server did not start');}
  ws=new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve);ws.addEventListener('error',reject);});
  const pending=new Map();
  let seq=0;
  const waiters=[];
  ws.addEventListener('message',async event=>{
    const msg=JSON.parse(event.data);
    if(msg.id&&pending.has(msg.id)){
      const {resolve,reject}=pending.get(msg.id);pending.delete(msg.id);
      if(msg.error)reject(new Error(JSON.stringify(msg.error)));else resolve(msg.result);
    }else if(msg.method){
      if(msg.method==='Runtime.exceptionThrown')logs.push('EXC '+(msg.params.exceptionDetails?.exception?.description||msg.params.exceptionDetails?.text));
      if(msg.method==='Runtime.consoleAPICalled'&&msg.params.type==='error')logs.push('CONSOLE '+msg.params.args.map(a=>a.value||a.description).join(' '));
      if(msg.method==='Fetch.requestPaused'&&msg.sessionId===sessionId){
        const url=msg.params.request.url;
        const id=msg.params.requestId;
        if(!/venice\.ai/i.test(url)){
          send('Fetch.continueRequest',{requestId:id}).catch(err=>logs.push('CONTINUE '+err.message));
          return;
        }
        const cors=[
          {name:'Access-Control-Allow-Origin',value:msg.params.request.headers?.Origin||msg.params.request.headers?.origin||'*'},
          {name:'Access-Control-Allow-Headers',value:'*'},
          {name:'Access-Control-Allow-Methods',value:'GET, POST, OPTIONS'},
          {name:'Content-Type',value:'application/json'}
        ];
        if(msg.params.request.method==='OPTIONS'){
          send('Fetch.fulfillRequest',{requestId:id,responseCode:204,responseHeaders:cors}).catch(err=>logs.push('FULFILL '+err.message));
          return;
        }
        const fail=url.includes('/chat/');
        const body=fail?JSON.stringify({error:'mock plan fallback'}):JSON.stringify({images:[PNG]});
        logs.push('MOCK '+msg.params.request.method+' '+url);
        send('Fetch.fulfillRequest',{
          requestId:id,
          responseCode:fail?500:200,
          responseHeaders:cors,
          body:Buffer.from(body).toString('base64')
        }).catch(err=>logs.push('FULFILL '+err.message));
      }
      for(const waiter of [...waiters])if(waiter.method===msg.method){waiter.resolve(msg.params);waiters.splice(waiters.indexOf(waiter),1);}
    }
  });
  function send(method,params={},sid=sessionId){
    const id=++seq;const payload={id,method,params};if(sid)payload.sessionId=sid;
    ws.send(JSON.stringify(payload));
    return new Promise((resolve,reject)=>pending.set(id,{resolve,reject}));
  }
  function waitEvent(method,timeout=20000){
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('timeout waiting '+method)),timeout);
      waiters.push({method,resolve:params=>{clearTimeout(timer);resolve(params);}});
    });
  }
  const {targetId}=await send('Target.createTarget',{url:`${origin}/icon.svg`},null);
  sessionId=(await send('Target.attachToTarget',{targetId,flatten:true},null)).sessionId;
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
  const blocked=[];
  ws.addEventListener('message',event=>{
    const msg=JSON.parse(event.data);
    if(msg.method==='Network.requestWillBeSent'&&msg.sessionId===sessionId&&/venice\.ai/i.test(msg.params.request.url))blocked.push(msg.params.request.url);
  });
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true});
  async function evalPage(expression,awaitPromise=false){
    const result=await send('Runtime.evaluate',{expression,awaitPromise,returnByValue:true});
    if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
    return result.result.value;
  }
  async function load(url){
    const loaded=waitEvent('Page.loadEventFired',20000);
    await send('Page.navigate',{url});
    await loaded;
    await delay(400);
  }
  async function shot(name){
    const image=await send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(`/opt/cursor/artifacts/${name}.png`,Buffer.from(image.data,'base64'));
  }
  async function clickText(text,timeout=8000){
    const start=Date.now();
    while(Date.now()-start<timeout){
      const ok=await evalPage(`(()=>{const b=[...document.querySelectorAll('button')].find(el=>el.textContent.includes(${JSON.stringify(text)}));if(!b)return false;b.click();return true;})()`);
      if(ok)return;
      await delay(80);
    }
    throw Error('button not found: '+text+' :: '+(await evalPage('document.body.innerText.slice(0,900)')));
  }
  async function clickYes(timeout=8000){
    const start=Date.now();
    while(Date.now()-start<timeout){
      const ok=await evalPage(`(()=>{const b=document.querySelector('dialog[open] [data-yes]');if(!b)return false;b.click();return true;})()`);
      if(ok)return;
      await delay(80);
    }
    throw Error('no confirm dialog :: '+(await evalPage('document.body.innerText.slice(0,900)')));
  }
  await load(`${origin}/`);
  const compressed=await evalPage(`(async()=>{
    const face=await import('./face.js');
    const jobs=await import('./jobs.js');
    const canvas=document.createElement('canvas');
    canvas.width=1200;canvas.height=1200;
    const ctx=canvas.getContext('2d',{alpha:false});
    const pixels=ctx.getImageData(0,0,canvas.width,canvas.height);
    const view=new Uint8Array(pixels.data.buffer);
    for(let i=0;i<view.length;i+=65536)crypto.getRandomValues(view.subarray(i,Math.min(view.length,i+65536)));
    for(let i=3;i<pixels.data.length;i+=4)pixels.data[i]=255;
    ctx.putImageData(pixels,0,0);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    const faceB64='A'.repeat(80);
    const b64=await face.prepareSwapTarget(blob,faceB64,'panel-large');
    const bytes=Uint8Array.from(atob(b64),ch=>ch.charCodeAt(0));
    const item={type:'swap',id:'panel-large',target_b64:b64,face_b64:faceB64};
    return {png:blob.size,out:bytes.length,jpeg:bytes[0]===255&&bytes[1]===216&&bytes[2]===255,item:jobs.jobBodyBytes([item]),limit:face.SWAP_ITEM_LIMIT,quality:face.SWAP_JPEG_QUALITY};
  })()`,true);
  if(!compressed.jpeg)throw Error('oversized Venice image was not JPEG: '+JSON.stringify(compressed));
  if(compressed.item>compressed.limit)throw Error('swap item exceeds 3 MB: '+JSON.stringify(compressed));
  if(compressed.quality!==0.9)throw Error('jpeg quality is not 0.9');
  if(!(compressed.png>compressed.limit))throw Error('fixture png was already under the limit: '+JSON.stringify(compressed));
  await evalPage(`document.querySelector('[data-nav="settings"]').click()`);
  await delay(150);
  await evalPage(`(()=>{document.querySelector('[name=panelCount]').value='3';document.querySelector('[name=drawOnPc]').checked=false;document.querySelector('#settingsForm').requestSubmit();})()`);
  await delay(200);
  await evalPage(`document.querySelector('[data-nav="library"]').click()`);
  await clickText('Try a sample story');
  await evalPage(`(()=>{window.__notes=[];const note=document.querySelector('#batchNote');const title=document.querySelector('#batchTitle');const push=()=>window.__notes.push((title.textContent||'')+' | '+(note.textContent||''));const obs=new MutationObserver(push);obs.observe(note,{childList:true,characterData:true,subtree:true});obs.observe(title,{childList:true,characterData:true,subtree:true});})()`);
  await clickText('3-panel comic');
  const demo=await evalPage(`new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{const tags=[...document.querySelectorAll('.engine-tag')].map(node=>node.textContent);const live=(document.querySelector('#batchTitle')?.textContent||'')+' | '+(document.querySelector('#batchNote')?.textContent||'');if(live.trim()!=='|')window.__notes.push(live);const notes=window.__notes||[];if(tags.length>=3&&notes.some(text=>/Venice is drawing panel \\d+/.test(text))){clearInterval(timer);resolve({tags,notes});}if(Date.now()-start>15000){clearInterval(timer);reject(new Error('demo labels missing '+JSON.stringify({tags,notes,text:document.body.innerText.slice(0,500)})));}},40);})`,true);
  if(demo.tags.some(label=>!label.startsWith('Venice')))throw Error('demo panels were not labeled Venice: '+JSON.stringify(demo.tags));
  if(demo.tags.some(label=>/PC face/.test(label)))throw Error('demo used the PC draw path: '+JSON.stringify(demo.tags));
  await shot('venice-demo-labels');
  await evalPage(`document.querySelector('[data-nav="characters"]').click()`);
  await clickText('Edit character');
  const uploaded=await evalPage(`(async()=>{
    const bytes=Uint8Array.from(atob(${JSON.stringify(PNG)}),ch=>ch.charCodeAt(0));
    const file=new File([bytes],'mira.png',{type:'image/png'});
    const input=document.querySelector('#referenceFile');
    const dt=new DataTransfer();
    dt.items.add(file);
    input.files=dt.files;
    input.dispatchEvent(new Event('change',{bubbles:true}));
    const start=Date.now();
    while(Date.now()-start<8000){
      if(document.querySelector('#characterForm img'))return true;
      await new Promise(r=>setTimeout(r,50));
    }
    return false;
  })()`,true);
  if(!uploaded)throw Error('reference upload did not stick: '+(await evalPage('document.body.innerText.slice(0,400)')));
  await evalPage(`document.querySelector('#characterForm').requestSubmit()`);
  await delay(300);
  await evalPage(`document.querySelector('[data-nav="settings"]').click()`);
  await evalPage(`(()=>{const demo=document.querySelector('[name=demo]');demo.checked=false;document.querySelector('[name=panelCount]').value='3';document.querySelector('[name=veniceKey]').value='not-a-real-key';document.querySelector('[name=localURL]').value=${JSON.stringify(gw.url)};document.querySelector('[name=localKey]').value=${JSON.stringify(gw.token)};document.querySelector('[name=drawOnPc]').checked=false;document.querySelector('#settingsForm').requestSubmit();})()`);
  await clickYes();
  await delay(200);
  await evalPage(`document.querySelector('[data-nav="library"]').click()`);
  await clickText('Open series');
  await clickText('Open');
  await evalPage(`document.querySelector('[data-tab="panels"]').click()`);
  await evalPage(`(()=>{window.__notes=[];})()`);
  await clickText('3-panel comic');
  await clickYes();
  await clickYes();
  await clickYes();
  const posted=await evalPage(`new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{const live=(document.querySelector('#batchTitle')?.textContent||'')+' | '+(document.querySelector('#batchNote')?.textContent||'');if(!live.endsWith('| '))window.__notes.push(live);const notes=window.__notes||[];const sawDraw=notes.some(text=>/Venice is drawing panel \\d+/.test(text));const sawSwap=notes.some(text=>text.includes("Swapping face on Dom's PC"));if(sawDraw&&sawSwap){clearInterval(timer);resolve(notes);}if(Date.now()-start>30000){clearInterval(timer);reject(new Error('progress missing '+JSON.stringify({notes,notice:document.querySelector('#notice')?.textContent||'',title:document.querySelector('#batchTitle')?.textContent||'',note:document.querySelector('#batchNote')?.textContent||''})));}},40);})`,true);
  const jobCall=()=>gw.calls.find(call=>call.method==='POST'&&call.path==='/jobs');
  for(let i=0;i<50&&!jobCall();i++)await delay(100);
  const jobPost=jobCall();
  if(!jobPost)throw Error('swap job was not posted '+JSON.stringify(gw.calls.map(call=>call.method+' '+call.path)));
  if(jobPost.body.items.some(item=>item.type!=='swap'||!item.target_b64||!item.face_b64))throw Error('swap payload missing images');
  if(jobPost.auth!=='Bearer '+gw.token)throw Error('swap job used the wrong token');
  if(JSON.stringify(gw.calls).includes('not-a-real-key'))throw Error('Venice key leaked to the PC');
  const jobId=[...gw.jobs.keys()].at(-1);
  const count=gw.jobs.get(jobId).items.length;
  for(let i=0;i<count;i++)gw.complete(jobId,i,PNG);
  const labels=await evalPage(`new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{const tags=[...document.querySelectorAll('.engine-tag')].map(node=>node.textContent);if(tags.some(label=>label==='Venice + PC face')&&!document.querySelector('#batchStatus:not([hidden])')){clearInterval(timer);resolve(tags);}if(Date.now()-start>20000){clearInterval(timer);reject(new Error('swapped label missing '+JSON.stringify({tags,notice:document.querySelector('#notice')?.textContent||''})));}},100);})`,true);
  if(!labels.some(label=>label==='Venice + PC face'))throw Error('no swapped label '+JSON.stringify(labels));
  await evalPage(`(()=>{const button=[...document.querySelectorAll('[data-action="toggle-face"]')].find(el=>el.textContent.includes('Original'));if(!button)throw Error('missing original toggle');button.click();})()`);
  await delay(100);
  const original=await evalPage(`[...document.querySelectorAll('.engine-tag')].map(node=>node.textContent)`);
  if(!original.some(label=>label==='Venice · original'))throw Error('toggle did not show the Venice original '+JSON.stringify(original));
  await evalPage(`(()=>{const button=[...document.querySelectorAll('[data-action="toggle-face"]')].find(el=>el.textContent.includes('Face-swapped'));button.click();})()`);
  await delay(100);
  const restored=await evalPage(`[...document.querySelectorAll('.engine-tag')].map(node=>node.textContent)`);
  if(!restored.some(label=>label==='Venice + PC face'))throw Error('toggle did not return to the swapped face '+JSON.stringify(restored));
  await shot('venice-pc-face');
  gw.control.swapFail='noface';
  await evalPage(`(()=>{const card=[...document.querySelectorAll('.panel-card')].find(node=>node.textContent.includes('Venice + PC face'));const button=card?.querySelector('[data-action="generate-panel"]');if(!button)throw Error('no swapped panel to regenerate');button.click();})()`);
  await clickYes();
  const failed=await evalPage(`new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{const card=[...document.querySelectorAll('.panel-card')].find(node=>node.textContent.includes('unswapped'));const again=card?.querySelector('[data-action="retry-swap"]');if(card&&again&&/Try again/.test(again.textContent)){clearInterval(timer);resolve(card.querySelector('.engine-tag')?.textContent||'');}if(Date.now()-start>20000){clearInterval(timer);reject(new Error('unswapped panel missing '+document.body.innerText.slice(0,700)));}},100);})`,true);
  if(failed!=='Venice · unswapped')throw Error('failed swap label was '+failed);
  gw.control.swapFail=null;
  await clickText('Try again');
  const retried=await evalPage(`new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{const tags=[...document.querySelectorAll('.engine-tag')].map(node=>node.textContent);if(tags.some(label=>label==='Venice + PC face')&&!document.querySelector('.panel-card .error-note')){clearInterval(timer);resolve(tags);}if(Date.now()-start>20000){clearInterval(timer);reject(new Error('retry did not swap '+JSON.stringify({tags,notice:document.querySelector('#notice')?.textContent||''})));}},100);})`,true);
  if(!gw.calls.some(call=>call.method==='POST'&&call.path==='/faceswap'&&call.auth==='Bearer '+gw.token))throw Error('single panel did not call /faceswap');
  const bad=logs.filter(line=>/EXC |TypeError|ReferenceError/.test(line));
  if(bad.length)throw Error(bad.join('\n'));
  console.log(JSON.stringify({compressed:{png:compressed.png,out:compressed.out,item:compressed.item},demo:demo.tags,progress:posted.filter(text=>/Venice is drawing|Swapping face/.test(text)),labels,original,retried,blocked:blocked.length},null,2));
}finally{
  if(logs.length)console.log(logs.slice(0,30).join('\n'));
  try{ws&&ws.close();}catch{}
  chrome.kill('SIGKILL');
  server.kill('SIGKILL');
  await gw.close();
}
