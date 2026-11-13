import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import fs from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {startMockGateway} from './mock-gateway.js';

const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const port=4173;
const origin=`http://127.0.0.1:${port}`;
const profile='/tmp/cs-gateway-chrome';
fs.rmSync(profile,{recursive:true,force:true});
await mkdir('/opt/cursor/artifacts',{recursive:true});
const gw=await startMockGateway('browser-local-token');
const server=spawn('python3',['-m','http.server',String(port),'--bind','127.0.0.1'],{cwd:'/workspace',stdio:'ignore'});
const chrome=spawn('google-chrome',[
  '--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
  '--remote-debugging-port=9334',`--user-data-dir=${profile}`,'about:blank'
],{stdio:'ignore'});
const logs=[];
let ws,sessionId;

async function json(path){
  const res=await fetch(`http://127.0.0.1:9334${path}`);
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
  ws.addEventListener('message',event=>{
    const msg=JSON.parse(event.data);
    if(msg.id&&pending.has(msg.id)){
      const {resolve,reject}=pending.get(msg.id);pending.delete(msg.id);
      if(msg.error)reject(new Error(JSON.stringify(msg.error)));else resolve(msg.result);
    }else if(msg.method){
      if(msg.method==='Runtime.exceptionThrown')logs.push('EXC '+(msg.params.exceptionDetails?.exception?.description||msg.params.exceptionDetails?.text));
      if(msg.method==='Runtime.consoleAPICalled'&&msg.params.type==='error')logs.push('CONSOLE '+msg.params.args.map(a=>a.value||a.description).join(' '));
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
  const blocked=[];
  ws.addEventListener('message',event=>{
    const msg=JSON.parse(event.data);
    if(msg.method==='Network.requestWillBeSent'&&msg.sessionId===sessionId){
      const url=msg.params.request.url;
      if(/venice\.ai/i.test(url))blocked.push(url);
    }
  });
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true});
  async function evalPage(expression,awaitPromise=false){
    const result=await send('Runtime.evaluate',{expression,awaitPromise,returnByValue:true});
    if(result.exceptionDetails){
      const text=result.exceptionDetails.exception?.description||result.exceptionDetails.text;
      throw Error(text);
    }
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
      await delay(100);
    }
    throw Error('button not found: '+text+' :: '+(await evalPage('document.body.innerText.slice(0,800)')));
  }
  await load(`${origin}/`);
  await evalPage(`document.querySelector('[data-nav="settings"]').click()`);
  await delay(150);
  await evalPage(`(()=>{const demo=document.querySelector('[name=demo]');demo.checked=false;document.querySelector('[name=panelCount]').value='3';document.querySelector('[name=localURL]').value=${JSON.stringify(gw.url)};document.querySelector('[name=localKey]').value='wrong-token';document.querySelector('[name=drawOnPc]').checked=true;document.querySelector('#settingsForm').requestSubmit();})()`);
  await clickText('Enable live mode');
  await delay(200);
  const saved=await evalPage(`document.querySelector('#notice')?.textContent||''`);
  if(!/Settings saved/.test(saved))throw Error('settings did not save: '+saved);
  await evalPage(`document.querySelector('[data-nav="library"]').click()`);
  await delay(100);
  await clickText('Try a sample story');
  await delay(200);
  await clickText('3-panel comic');
  await clickText('Start images');
  const tokenError=await evalPage(`new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{const note=document.querySelector('#notice');const text=note?.textContent||'';const button=[...document.querySelectorAll('#notice button')].some(b=>b.textContent==='Try again');if(/token/i.test(text)&&button&&note.classList.contains('error')){clearInterval(timer);resolve(text);}if(Date.now()-start>15000){clearInterval(timer);reject(new Error('no token error: '+text));}},100);})`,true);
  if(/Venice/i.test(tokenError))throw Error('token error mentioned Venice: '+tokenError);
  await shot('local-token-error');
  await evalPage(`localStorage.setItem('cs_local_k',${JSON.stringify(gw.token)})`);
  await clickText('Try again');
  const started=await evalPage(`new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{const title=document.querySelector('#batchTitle')?.textContent||'';const note=document.querySelector('#batchNote')?.textContent||'';const batch=document.querySelector('#batchStatus');const visible=batch&&!batch.hidden;const err=document.querySelector('#notice.error')?.textContent||'';if(visible&&/Rendering on your PC/.test(title)&&/PC|switch apps|lock/i.test(note)){clearInterval(timer);resolve({title,note,err});return;}if(Date.now()-start>20000){clearInterval(timer);reject(new Error('job did not start: '+title+' '+note+' '+err+' '+document.body.innerText.slice(0,400)));}},100);})`,true);
  await shot('local-job-progress');
  const posted=gw.calls.find(call=>call.method==='POST'&&call.path==='/jobs');
  if(!posted)throw Error('comic was not submitted as a batch job');
  const panelIds=posted.body.items.map(item=>item.id);
  if(panelIds.length!==3)throw Error('expected 3 panels, got '+panelIds.length);
  const jobId=[...gw.jobs.keys()][0];
  if(!jobId)throw Error('gateway has no job');
  const stored=await evalPage(`new Promise((resolve,reject)=>{const req=indexedDB.open('comic-studio');req.onsuccess=()=>{const get=req.result.transaction('library').objectStore('library').get('root');get.onsuccess=()=>{const ep=get.result.series[0].episodes[0];resolve({job:ep.imageJob?.jobId||'',panels:ep.pages.flatMap(p=>p.panels).map(p=>p.id)});};};req.onerror=()=>reject(req.error);})`,true);
  if(stored.job!==jobId)throw Error('job id was not saved with the episode: '+JSON.stringify(stored));
  if(stored.panels.join()!==panelIds.join())throw Error('job order is not script order '+JSON.stringify({stored,panelIds}));
  await load(`${origin}/`);
  for(let i=0;i<panelIds.length;i++)gw.complete(jobId,i,PNG);
  const finished=await evalPage(`new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{const req=indexedDB.open('comic-studio');req.onsuccess=()=>{const db=req.result;const get=db.transaction('library').objectStore('library').get('root');get.onsuccess=()=>{const ep=get.result.series[0].episodes[0];const panels=ep.pages.flatMap(p=>p.panels);const images=panels.filter(p=>p.imageId).length;db.close();if(images===3&&!ep.imageJob){clearInterval(timer);resolve({images,ids:panels.map(p=>p.id)});}if(Date.now()-start>20000){clearInterval(timer);reject(new Error('resume did not collect '+JSON.stringify({images,job:ep.imageJob||null,notice:document.querySelector('#notice')?.textContent||'',title:document.querySelector('#batchTitle')?.textContent||''})));}};};},250);})`,true);
  if(finished.ids.join()!==panelIds.join())throw Error('resumed images were not kept in script order');
  if(gw.jobs.has(jobId))throw Error('finished job was not deleted');
  if(!gw.calls.some(call=>call.method==='DELETE'&&call.path===`/jobs/${jobId}`))throw Error('DELETE was not called');
  await evalPage(`(()=>{[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Open series')).click();})()`);
  await delay(150);
  await evalPage(`(()=>{[...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith('Open')).click();})()`);
  await delay(150);
  await evalPage(`document.querySelector('[data-tab="panels"]').click()`);
  await delay(300);
  const shown=await evalPage(`document.querySelectorAll('.panel-card img[data-image-id]').length`);
  if(shown<3)throw Error('storyboard did not show the resumed panels: '+shown);
  const engines=await evalPage(`[...document.querySelectorAll('.engine-tag')].map(node=>node.textContent)`);
  if(!Array.isArray(engines)||engines.length<3||engines.some(label=>label!=='PC face match'))throw Error('panels did not say which engine made them: '+JSON.stringify(engines));
  await evalPage(`document.querySelector('.engine-tag')?.scrollIntoView({block:'center'})`);
  await delay(200);
  await shot('local-job-resumed');
  if(blocked.length)throw Error('Venice was called: '+blocked.join(','));
  const bad=logs.filter(line=>/EXC |TypeError|ReferenceError/.test(line));
  if(bad.length)throw Error(bad.join('\n'));
  console.log(JSON.stringify({tokenError:tokenError.slice(0,180),started,jobId,panelIds,finished,shown,calls:gw.calls.map(call=>call.method+' '+call.path)},null,2));
}finally{
  try{ws&&ws.close();}catch{}
  chrome.kill('SIGKILL');
  server.kill('SIGKILL');
  await gw.close();
}
