import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import fs from 'node:fs';
import {mkdir} from 'node:fs/promises';

const port=9333;
const origin='http://127.0.0.1:4173';
const profile='/tmp/cs-chrome-profile';
fs.rmSync(profile,{recursive:true,force:true});
await mkdir('/opt/cursor/artifacts',{recursive:true});
const chrome=spawn('google-chrome',[
  '--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
  `--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'about:blank'
],{stdio:'ignore'});
const logs=[];
let ws,sessionId;

async function json(path){
  const res=await fetch(`http://127.0.0.1:${port}${path}`);
  if(!res.ok) throw Error(path+' '+res.status);
  return res.json();
}
try{
  let version;
  for(let i=0;i<50;i++){try{version=await json('/json/version');break;}catch{await delay(100);}}
  if(!version) throw Error('Chrome did not open a debugging port');
  ws=new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve);ws.addEventListener('error',reject);});
  const pending=new Map();
  let seq=0;
  const waiters=[];
  ws.addEventListener('message',event=>{
    const msg=JSON.parse(event.data);
    if(msg.id&&pending.has(msg.id)){
      const {resolve,reject}=pending.get(msg.id);pending.delete(msg.id);
      if(msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
    }else if(msg.method){
      if(msg.method==='Runtime.exceptionThrown') logs.push('EXC '+(msg.params.exceptionDetails?.exception?.description||msg.params.exceptionDetails?.text));
      if(msg.method==='Runtime.consoleAPICalled'&&msg.params.type==='error') logs.push('CONSOLE '+msg.params.args.map(a=>a.value||a.description).join(' '));
      for(const waiter of [...waiters]) if(waiter.method===msg.method){waiter.resolve(msg.params);waiters.splice(waiters.indexOf(waiter),1);}
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
      if(/venice\.ai|api\.openai|generativelanguage/i.test(url)) blocked.push(url);
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
    await delay(200);
  }
  await load(`${origin}/icon.svg`);
  await evalPage(`new Promise((resolve,reject)=>{
    const req=indexedDB.open('comic-studio',1);
    req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains('library'))db.createObjectStore('library');if(!db.objectStoreNames.contains('assets'))db.createObjectStore('assets',{keyPath:'id'});};
    req.onerror=()=>reject(req.error);
    req.onsuccess=()=>{const db=req.result;const tx=db.transaction('library','readwrite');
      tx.objectStore('library').put({schemaVersion:1,characters:[{id:'c1',age:32,fictional:true,refId:null,name:'Mira Vale',description:'An expressive adult woman with amber eyes.',personality:'Warm',backstory:'A cartographer.',body:'Athletic adult build',hair:'Dark curls',outfit:'Copper jacket',tattoos:'A constellation'}],series:[{id:'s1',title:'Keep Me',synopsis:'Two grown explorers.',style:'Stylized adult comic art.',episodes:[{id:'e1',title:'Garden',script:'Mira: Stay with me tonight.\\n\\nRowan smiles. \"I am already here.\"\\n\\nThe shuttle is already gone.',previousScript:'',cast:['c1'],pages:[]}]}]},'root');
      tx.oncomplete=()=>{db.close();resolve('seeded');};tx.onerror=()=>reject(tx.error);};
  })`,true);
  await load(`${origin}/`);
  await delay(400);
  const migrated=await evalPage(`new Promise((resolve,reject)=>{const req=indexedDB.open('comic-studio');req.onsuccess=()=>{const tx=req.result.transaction('library');const get=tx.objectStore('library').get('root');get.onsuccess=()=>{const lib=get.result;resolve({schema:lib.schemaVersion,title:lib.series[0].title,bubbles:Array.isArray(lib.series[0].episodes[0].pages)?true:false,chars:lib.characters.length});};};req.onerror=()=>reject(req.error);})`,true);
  if(migrated.schema!==2||migrated.title!=='Keep Me'||migrated.chars!==1) throw Error('migration failed '+JSON.stringify(migrated));
  const label=await evalPage(`(()=>{const open=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Open series'));open.click();return document.body.innerText.includes('Keep Me');})()`);
  if(!label) throw Error('library did not show the migrated series');
  await delay(100);
  await evalPage(`(()=>{const open=[...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith('Open'));open.click();})()`);
  await delay(150);
  const button45=await evalPage(`(()=>[...document.querySelectorAll('button')].some(b=>b.textContent.includes('45-panel comic')))()`);
  if(!button45) throw Error('default generate button is not 45 panels: '+await evalPage('document.body.innerText.slice(0,500)'));
  const overflow=await evalPage(`document.documentElement.scrollWidth<=document.documentElement.clientWidth+1`);
  if(!overflow) throw Error('horizontal overflow on the episode screen');
  await evalPage(`document.querySelector('[data-nav="settings"]').click()`);
  await delay(100);
  await evalPage(`(()=>{const input=document.querySelector('[name=panelCount]');input.value='4';document.querySelector('#settingsForm').requestSubmit();return input.value;})()`);
  await delay(200);
  const saved=await evalPage(`document.querySelector('#notice')?.textContent||''`);
  if(!/Settings saved/.test(saved)) throw Error('settings did not save: '+saved);
  await evalPage(`document.querySelector('[data-nav="library"]').click()`);
  await delay(100);
  await evalPage(`(()=>{[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Open series')).click();})()`);
  await delay(100);
  await evalPage(`(()=>{[...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith('Open')).click();})()`);
  await delay(150);
  const button4=await evalPage(`(()=>[...document.querySelectorAll('button')].some(b=>b.textContent.includes('4-panel comic')))()`);
  if(!button4) throw Error('panel count setting did not change the button');
  await evalPage(`(()=>{window.__venice=0;const orig=window.fetch.bind(window);window.fetch=(...args)=>{const url=String(args[0]&&args[0].url||args[0]);if(/venice\\.ai/i.test(url))window.__venice++;return orig(...args);};[...document.querySelectorAll('button')].find(b=>b.textContent.includes('4-panel comic')).click();})()`);
  const generated=await evalPage(`new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{const cards=document.querySelectorAll('.panel-card').length;const imgs=[...document.querySelectorAll('.panel-card img')].filter(img=>img.src&&!img.hidden).length;const note=document.querySelector('#notice')?.textContent||'';const err=document.querySelector('#notice.error')?.textContent||'';if(err){clearInterval(timer);reject(new Error(err));return;}if(cards>=4&&imgs>=4){clearInterval(timer);resolve({cards,imgs,note,count:document.querySelector('#batchCount')?.textContent||''});}if(Date.now()-start>60000){clearInterval(timer);reject(new Error('generate timeout cards='+cards+' imgs='+imgs+' note='+note+' batch='+(document.querySelector('#batchCount')?.textContent||'')));}},200);})`,true);
  if(generated.imgs<4) throw Error('images missing '+JSON.stringify(generated));
  const autoLettering=await evalPage(`document.querySelectorAll('.panel-card .bubble, .panel-card .placed-bubble, .panel-card .caption, .panel-card .lettering-layer').length`);
  if(autoLettering) throw Error('generated panels already have speech bubbles: '+autoLettering);
  const venice=await evalPage('window.__venice||0');
  if(venice) throw Error('Venice was called '+venice+' times');
  await evalPage(`(()=>{[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Speech bubbles').click();})()`);
  await delay(300);
  const presets=await evalPage(`document.querySelectorAll('#lettering .preset').length`);
  if(presets!==5) throw Error('expected 5 bubble presets, saw '+presets);
  await evalPage(`document.querySelector('#lettering [data-preset="round-speech"]').click()`);
  await delay(100);
  await evalPage(`(()=>{const ta=document.querySelector('#lettering textarea');if(!ta)throw Error('no bubble text field');ta.focus();ta.value='Hello from the garden';ta.dispatchEvent(new Event('input',{bubbles:true}));const range=document.querySelector('[data-bubble-font]');range.value='0.08';range.dispatchEvent(new Event('input',{bubbles:true}));[...document.querySelectorAll('#lettering button')].find(b=>b.textContent.includes('Flip tail')).click();})()`);
  await delay(100);
  const dragged=await evalPage(`(()=>{const stage=document.querySelector('[data-bubble-stage]');const bubble=document.querySelector('#lettering .placed-bubble');const before=bubble.style.left;const r=bubble.getBoundingClientRect();const down=new PointerEvent('pointerdown',{bubbles:true,cancelable:true,clientX:r.left+30,clientY:r.top+r.height-18,pointerId:7,pointerType:'touch',isPrimary:true});bubble.dispatchEvent(down);const move=new PointerEvent('pointermove',{bubbles:true,cancelable:true,clientX:r.left+80,clientY:r.top+r.height+30,pointerId:7,pointerType:'touch',isPrimary:true});stage.dispatchEvent(move);const up=new PointerEvent('pointerup',{bubbles:true,cancelable:true,clientX:r.left+80,clientY:r.top+r.height+30,pointerId:7,pointerType:'touch',isPrimary:true});stage.dispatchEvent(up);return {before,after:bubble.style.left,text:document.querySelector('#lettering textarea').value};})()`);
  if(dragged.text!=='Hello from the garden') throw Error('text was not kept '+JSON.stringify(dragged));
  if(dragged.before===dragged.after) throw Error('drag did not move the bubble '+JSON.stringify(dragged));
  const shot=await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync('/opt/cursor/artifacts/bubble-editor.png',Buffer.from(shot.data,'base64'));
  await evalPage(`(()=>{[...document.querySelectorAll('#lettering button')].find(b=>b.textContent.trim()==='Done').click();})()`);
  await delay(300);
  const onPanel=await evalPage(`document.body.innerText.includes('Hello from the garden')`);
  if(!onPanel) throw Error('bubble text is not on the panel');
  await load(`${origin}/`);
  await delay(400);
  const still=await evalPage(`new Promise((resolve,reject)=>{const req=indexedDB.open('comic-studio');req.onsuccess=()=>{const get=req.result.transaction('library').objectStore('library').get('root');get.onsuccess=()=>{const lib=get.result;const panels=lib.series[0].episodes[0].pages.flatMap(p=>p.panels);resolve({title:lib.series[0].title,schema:lib.schemaVersion,panels:panels.length,images:panels.filter(p=>p.imageId).length,text:panels.some(p=>(p.bubbles||[]).some(b=>b.text==='Hello from the garden'))});};};req.onerror=()=>reject(req.error);})`,true);
  if(!still.text||still.schema!==2||still.title!=='Keep Me'||still.panels!==4||still.images!==4) throw Error('reload lost data '+JSON.stringify(still));
  await evalPage(`(()=>{[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Open series')).click();})()`);
  await delay(80);
  await evalPage(`(()=>{[...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith('Open')).click();})()`);
  await delay(100);
  await evalPage(`document.querySelector('[data-tab="panels"]').click()`);
  await delay(100);
  const readerShot=await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync('/opt/cursor/artifacts/storyboard.png',Buffer.from(readerShot.data,'base64'));
  const persistedText=await evalPage(`document.body.innerText.includes('Hello from the garden')`);
  if(!persistedText) throw Error('bubble did not render after reload');
  if(blocked.length) throw Error('blocked network calls '+blocked.join(','));
  await evalPage(`document.querySelector('[data-nav="settings"]').click()`);
  await delay(80);
  await evalPage(`(()=>{document.querySelector('[name=panelCount]').value='45';document.querySelector('#settingsForm').requestSubmit();})()`);
  await delay(150);
  await evalPage(`document.querySelector('[data-nav="library"]').click()`);
  await delay(80);
  await evalPage(`(()=>{[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Open series')).click();})()`);
  await delay(80);
  await evalPage(`(()=>{[...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith('Open')).click();})()`);
  await delay(100);
  const has45=await evalPage(`(()=>[...document.querySelectorAll('button')].some(b=>b.textContent.includes('45-panel comic')))()`);
  if(!has45) throw Error('45-panel button missing after restoring the setting');
  await evalPage(`(()=>{[...document.querySelectorAll('button')].find(b=>b.textContent.includes('45-panel comic')).click();})()`);
  await delay(100);
  await evalPage(`(()=>{const yes=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Replace and generate'));if(!yes)throw Error('replace confirm missing');yes.click();})()`);
  const cancelAt=await evalPage(`new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{const count=document.querySelector('#batchCount')?.textContent||'';const m=count.match(/^(\\d+)\\/45$/);const button=document.querySelector('#batchCancel');const note=document.querySelector('#notice')?.textContent||'';if(m&&button&&Number(m[1])>=1&&Number(m[1])<45&&!button.closest('[hidden]')){clearInterval(timer);button.click();resolve(count);return;}if(/Demo comic ready, 45/.test(note)){clearInterval(timer);resolve('done:'+note);return;}if(Date.now()-start>45000){clearInterval(timer);reject(new Error('45-panel progress never started: '+count+' '+note));}},40);})`,true);
  let resumeInfo=null;
  if(!String(cancelAt).startsWith('done:')){
    resumeInfo=await evalPage(`new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{const note=document.querySelector('#notice')?.textContent||'';const resume=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Resume images'));const imgs=[...document.querySelectorAll('.panel-card img')].filter(img=>img.dataset.imageId);if(/Stopped at/.test(note)&&resume&&!resume.disabled){clearInterval(timer);resolve({note,resume:resume.textContent,kept:imgs.map(img=>img.dataset.imageId)});}if(Date.now()-start>15000){clearInterval(timer);reject(new Error('cancel did not settle: '+note));}},50);})`,true);
    if(!resumeInfo.kept.length) throw Error('cancel dropped finished panels '+JSON.stringify(resumeInfo));
    await evalPage(`(()=>{[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Resume images')).click();})()`);
    const finished=await evalPage(`new Promise((resolve,reject)=>{const kept=${JSON.stringify(resumeInfo.kept)};const start=Date.now();const timer=setInterval(()=>{const note=document.querySelector('#notice')?.textContent||'';const err=document.querySelector('#notice.error')?.textContent||'';const ids=[...document.querySelectorAll('.panel-card img')].map(img=>img.dataset.imageId).filter(Boolean);if(err){clearInterval(timer);reject(new Error(err));return;}if(/Demo comic ready, 45\\/45/.test(note)&&ids.length>=45){clearInterval(timer);resolve({note,ids,keptOk:kept.every(id=>ids.includes(id))});}if(Date.now()-start>90000){clearInterval(timer);reject(new Error('resume timeout '+ids.length+' '+note));}},200);})`,true);
    if(!finished.keptOk) throw Error('resume regenerated finished panels');
    resumeInfo.finished=finished.note;
  }
  await evalPage(`(()=>{[...document.querySelectorAll('button')].find(b=>b.dataset.action==='read'||b.textContent.includes('Read episode')||b.textContent.includes('Read')).click();})()`);
  await delay(200);
  const reader=await evalPage(`document.querySelector('#reader')?.innerText||''`);
  if(!/Page 1 \/ 8/.test(reader)) throw Error('reader is not an 8-page comic: '+reader.slice(0,300));
  const pageShot=await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync('/opt/cursor/artifacts/reader-45.png',Buffer.from(pageShot.data,'base64'));
  const bad=logs.filter(line=>/EXC |TypeError|ReferenceError|not a function/.test(line));
  if(bad.length) throw Error(bad.join('\n'));
  console.log(JSON.stringify({migrated,generated,dragged,still,presets,cancelAt,resumeInfo,reader:reader.match(/Page 1 \/ 8/)[0],logs},null,2));
}finally{
  try{ws&&ws.close();}catch{}
  chrome.kill('SIGKILL');
}
