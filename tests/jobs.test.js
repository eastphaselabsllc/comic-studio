import test from 'node:test';
import assert from 'node:assert/strict';
import {buildEpisodePages, libraryNeedsMigration, migrateLibrary, validateLibrary} from '../core.js';
import {Provider, defaults, explainRequestError} from '../provider.js';
import {buildJobItems, collectGatewayJob, driveImageJobs, episodeCharacterPool, hasImageJob, jobBodyBytes, nextPollDelay, normalizeImageJob, resolvePanelId, useLocalJob, waitUntilVisible, JOB_POLL_FAST_MS, JOB_POLL_SLOW_MS} from '../jobs.js';
import {startMockGateway} from './mock-gateway.js';

const memory=new Map();
globalThis.localStorage={
  getItem:key=>memory.has(key)?memory.get(key):null,
  setItem:(key,value)=>memory.set(key,String(value)),
  removeItem:key=>memory.delete(key),
  clear:()=>memory.clear()
};

const faceA='A'.repeat(48);
const faceB='B'.repeat(48);
const mira={id:'c1',name:'Mira',age:32,fictional:true,description:'amber eyes and a silver piercing',hair:'dark curls',body:'athletic adult build',outfit:'copper jacket',tattoos:'a constellation',personality:'warm',backstory:'a cartographer',refId:'ref-mira'};
const rowan={id:'c2',name:'Rowan',age:35,fictional:true,description:'green eyes',hair:'short black hair',body:'broad shoulders',outfit:'charcoal coat',tattoos:'a leaf',personality:'patient',backstory:'a gardener',refId:'ref-rowan'};
const nora={id:'c3',name:'Nora',age:29,fictional:true,description:'an adult woman with a calm face',hair:'',body:'',outfit:'',tattoos:'',personality:'',backstory:'',refId:null};
const script=['Mira opens the kitchen door.','The kitchen is quiet.','Rowan stands outside with the keys.','Mira hands Rowan the box.'].join('\n\n');

function faces(id){return id==='ref-mira'?`data:image/jpeg;base64,${faceA}`:id==='ref-rowan'?`data:image/jpeg;base64,${faceB}`:'';}

test('local comic jobs are used only outside demo mode, and the poll slows down', ()=>{
  assert.equal(useLocalJob({demo:true,localURL:'https://pc.example'}), false);
  assert.equal(useLocalJob({demo:false,localURL:''}), false);
  assert.equal(useLocalJob({demo:false,localURL:'  https://pc.example  '}), true);
  assert.equal(nextPollDelay(0), JOB_POLL_FAST_MS);
  assert.equal(nextPollDelay(29999), JOB_POLL_FAST_MS);
  assert.equal(nextPollDelay(30000), JOB_POLL_SLOW_MS);
  assert.equal(JOB_POLL_FAST_MS, 3000);
  assert.ok(JOB_POLL_SLOW_MS>=8000&&JOB_POLL_SLOW_MS<=10000);
});

test('job items stay in script order and use the face of the person named in that beat', async ()=>{
  const pages=buildEpisodePages({script,cast:['c1','c2'],count:4,characters:[mira,rowan]});
  const panels=pages.flatMap(page=>page.panels);
  assert.equal(panels.length, 4);
  panels[1].imageId='already-saved';
  let lookedUp=false;
  const noraPages=buildEpisodePages({script:'Nora waits by the glass.',cast:['c3'],count:1,characters:[nora]});
  const noraJob=await buildJobItems(noraPages.flatMap(page=>page.panels),[nora],'Ink',()=>{lookedUp=true;return `data:image/jpeg;base64,${'C'.repeat(40)}`;});
  assert.equal(lookedUp, false);
  assert.equal(noraJob.items[0].face_b64, undefined);
  const built=await buildJobItems(panels,[mira,rowan],'Ink',faces);
  assert.deepEqual(built.panelIds, [panels[0].id,panels[2].id,panels[3].id]);
  assert.equal(built.items[0].face_b64, faceA);
  assert.match(built.items[0].prompt, /kitchen door/);
  assert.equal(built.items[1].face_b64, faceB);
  assert.match(built.items[1].prompt, /keys/);
  assert.equal(built.items[2].face_b64, faceA);
  assert.match(built.items[2].prompt, /box/);
  assert.ok(built.items[0].prompt.indexOf('Mira')<built.items[2].prompt.indexOf('box')||built.items[2].prompt.includes('box'));
  for(const item of built.items){
    assert.equal(item.width, 832);
    assert.equal(item.height, 1216);
    assert.equal(item.steps, 28);
    assert.equal(item.cfg_scale, 7);
    assert.match(item.negative_prompt, /speech bubble/);
    assert.equal(item.seed, undefined);
    assert.equal(item.model, undefined);
    assert.equal(item.style_references, undefined);
    assert.equal(item.safe_mode, undefined);
  }
  const quiet=buildEpisodePages({script:'The kitchen is quiet.',cast:['c1','c2'],count:1,characters:[mira,rowan]});
  const quietJob=await buildJobItems(quiet.flatMap(page=>page.panels),[rowan,mira],'Ink',faces);
  assert.equal(quietJob.items[0].face_b64, undefined);
  assert.doesNotMatch(quietJob.items[0].prompt, /Do not show/);
  assert.match(quietJob.items[0].negative_prompt, /face tattoo, facial tattoo, neck tattoo, cheek markings/);
});

test('each panel uses its focus character, restates appearance, and keeps body tattoos off close-ups', async ()=>{
  const miraVale={...mira,name:'Mira Vale',description:'An adult woman with warm brown skin, amber eyes, and a silver piercing.',tattoos:'Fine geometric constellation on the left forearm'};
  const rowanAsh={...rowan,name:'Rowan Ash',description:'An adult man with olive skin and green eyes.',tattoos:'a leaf on the right wrist'};
  const cheek={...mira,id:'c4',name:'Nia Cole',refId:'ref-nia',description:'amber eyes',tattoos:'a small star tattoo on the left cheek',hair:'auburn waves'};
  const looked=[];
  const faceFor=id=>{looked.push(id);return faces(id);};
  const stuck=[
    {id:'p-rowan',prompt:'Rowan waits on the platform.',camera:'Over the shoulder',cast:['c1','c2'],dialogue:'',caption:'',imageId:null},
    {id:'p-mira',prompt:'Mira studies the map.',camera:'Wide establishing shot',cast:['c1','c2'],dialogue:'',caption:'',imageId:null},
    {id:'p-quiet',prompt:'The docking bay is empty.',camera:'Medium shot, eye level',cast:['c1','c2'],dialogue:'',caption:'',imageId:null},
    {id:'p-close',prompt:'Close on Rowan as Mira talks with Mira about the map.',camera:'Close-up, three-quarter view',cast:['c1','c2'],dialogue:'',caption:'',imageId:null},
    {id:'p-rear',prompt:'Mira watches the stars from behind.',camera:'Over the shoulder',cast:['c1','c2'],dialogue:'',caption:'',imageId:null},
    {id:'p-tie',prompt:'Mira hands Rowan the box.',camera:'Medium shot, eye level',cast:['c2','c1'],dialogue:'',caption:'',imageId:null},
    {id:'p-dialogue',prompt:'The hall is quiet.',camera:'Head and shoulders',cast:['c1','c2'],dialogue:'Rowan: I kept the light on.',caption:'',imageId:null},
    {id:'p-count',prompt:'Mira passes the window. Rowan looks at Rowan.',camera:'Wide establishing shot',cast:['c1','c2'],dialogue:'',caption:'',imageId:null}
  ];
  const pool=episodeCharacterPool([miraVale,rowanAsh,{...nora,name:'Nora Quinn'}],['c1','c2'],stuck);
  assert.deepEqual(pool.map(c=>c.id),['c1','c2']);
  const built=await buildJobItems(stuck,pool,'Ink',faceFor);
  const byId=new Map(built.items.map(item=>[item.id,item]));
  assert.equal(byId.get('p-rowan').face_b64, faceB);
  assert.match(byId.get('p-rowan').prompt, /ROWAN ASH:/);
  assert.doesNotMatch(byId.get('p-rowan').prompt, /on the left/);
  assert.match(byId.get('p-rowan').prompt, /short black hair/);
  assert.match(byId.get('p-rowan').prompt, /green eyes/);
  assert.match(byId.get('p-rowan').prompt, /olive skin/);
  assert.match(byId.get('p-rowan').prompt, /Do not show Rowan Ash from behind/);
  assert.match(byId.get('p-rowan').prompt, /Three-quarter or front view, face visible/);
  assert.doesNotMatch(byId.get('p-rowan').prompt, /Over the shoulder/);
  assert.ok(byId.get('p-rowan').prompt.indexOf('ROWAN ASH:')<byId.get('p-rowan').prompt.indexOf('Scene:'));
  assert.equal(byId.get('p-mira').face_b64, faceA);
  assert.match(byId.get('p-mira').prompt, /warm brown skin/);
  assert.match(byId.get('p-mira').prompt, /amber eyes/);
  assert.match(byId.get('p-mira').prompt, /left forearm/);
  assert.equal(byId.get('p-quiet').face_b64, undefined);
  assert.equal(looked.includes(''), false);
  assert.doesNotMatch(byId.get('p-quiet').prompt, /three-quarter or front view/i);
  assert.equal(byId.get('p-close').face_b64, faceB);
  assert.match(byId.get('p-close').prompt, /ROWAN ASH \(on the left\):/);
  assert.match(byId.get('p-close').prompt, /MIRA VALE \(on the right\):/);
  assert.ok(byId.get('p-close').prompt.indexOf('ROWAN ASH')<byId.get('p-close').prompt.indexOf('MIRA VALE'));
  assert.match(byId.get('p-close').prompt, /dark curls/);
  assert.doesNotMatch(byId.get('p-close').prompt, /forearm|wrist/);
  assert.match(byId.get('p-close').prompt, /short black hair/);
  assert.doesNotMatch(byId.get('p-close').prompt, /, and tattoos/);
  assert.match(byId.get('p-rear').prompt, /from behind/);
  assert.doesNotMatch(byId.get('p-rear').prompt, /Do not show/);
  assert.match(byId.get('p-rear').prompt, /Over the shoulder/);
  assert.equal(byId.get('p-tie').face_b64, faceA);
  assert.match(byId.get('p-tie').prompt, /MIRA VALE \(on the left\):/);
  assert.match(byId.get('p-tie').prompt, /ROWAN ASH \(on the right\):/);
  assert.match(byId.get('p-tie').prompt, /short black hair/);
  assert.match(byId.get('p-tie').prompt, /left forearm/);
  assert.equal(byId.get('p-dialogue').face_b64, faceB);
  assert.doesNotMatch(byId.get('p-dialogue').prompt, /wrist|forearm/);
  assert.equal(byId.get('p-count').face_b64, faceB);
  for(const item of built.items){
    if(item.id==='p-cheek')continue;
    assert.match(item.negative_prompt, /face tattoo, facial tattoo, neck tattoo, cheek markings/);
  }
  const cheekJob=await buildJobItems([{id:'p-cheek',prompt:'Close-up of Nia Cole.',camera:'Head and shoulders',cast:['c4'],dialogue:'',caption:'',imageId:null}],[cheek],'Ink',id=>id==='ref-nia'?`data:image/jpeg;base64,${'N'.repeat(48)}`:'');
  assert.match(cheekJob.items[0].prompt, /star tattoo on the left cheek/);
  assert.doesNotMatch(cheekJob.items[0].negative_prompt, /cheek markings/);
  assert.match(cheekJob.items[0].negative_prompt, /speech bubble/);
  const word=await buildJobItems([{id:'p-word',prompt:'Rowanwood stays empty while Rowan waits.',camera:'Medium shot',cast:['c2'],dialogue:'',caption:'',imageId:null}],[rowanAsh],'Ink',faces);
  assert.equal(word.items[0].face_b64, faceB);
  const ambiguous=await buildJobItems([{id:'p-alex',prompt:'Alex waits by the glass.',camera:'Medium shot',cast:['a1','a2'],dialogue:'',caption:'',imageId:null}],[{id:'a1',name:'Alex Stone',refId:'ref-a',hair:'black hair',description:'brown eyes',age:30},{id:'a2',name:'Alex Reed',refId:'ref-b',hair:'red hair',description:'blue eyes',age:31}],()=>{throw Error('ambiguous names should not look up a face');});
  assert.equal(ambiguous.items[0].face_b64, undefined);
  const plain=await buildJobItems([{id:'p-nora',prompt:'Nora waits by the glass.',camera:'Close-up',cast:['c3'],dialogue:'',caption:'',imageId:null}],[nora], 'Ink',()=>{throw Error('a character without a reference is plain generation');});
  assert.equal(plain.items[0].face_b64, undefined);
  assert.match(plain.items[0].prompt, /NORA/);
  assert.doesNotMatch(plain.items[0].prompt, /Do not show/);
});

test('a 422 no-face result stays on that panel and can be retried without Venice', async ()=>{
  const gw=await startMockGateway();
  const urls=[];
  const original=globalThis.fetch;
  globalThis.fetch=async(url,opts)=>{urls.push(String(url));return original(url,opts);};
  try{
    localStorage.setItem('cs_k','venice-key-should-not-leak');
    localStorage.setItem('cs_local_k',gw.token);
    const provider=new Provider({...defaults,demo:false,localURL:gw.url,allowCloudFallback:true},async()=>{throw Error('no face must not ask for Venice');});
    const created=await provider.createImageJob([{id:'ok',prompt:'Mira opens the door.'},{id:'miss',prompt:'Rowan faces the camera.'}]);
    gw.complete(created.job_id,0,'KEPT-PANEL');
    gw.rejectItem(created.job_id,1,'No face found',422);
    const record={jobId:created.job_id,panelIds:['ok','miss'],fetched:[]};
    const saved=[];
    const result=await collectGatewayJob({
      record,
      poll:()=>provider.imageJobStatus(record.jobId),
      fetchItem:index=>provider.imageJobItem(record.jobId,index),
      saveItem:async(panelId,image)=>{saved.push({panelId,image});},
      deleteJob:()=>provider.deleteImageJob(record.jobId),
      cancelJob:()=>provider.cancelImageJob(record.jobId),
      sleep:async()=>{throw Error('a finished no-face item should not keep polling');}
    });
    assert.equal(result.finished,true);
    assert.equal(result.deleted,true);
    assert.deepEqual(saved,[{panelId:'ok',image:'KEPT-PANEL'}]);
    const missed=result.errors.find(item=>item.panelId==='miss'||item.id==='miss');
    assert.equal(missed.message,'No face found in this panel. Try again.');
    assert.equal(missed.status,'error');
    assert.equal(urls.some(url=>/venice\.ai/i.test(url)),false);
    assert.equal(JSON.stringify(gw.calls).includes('venice-key-should-not-leak'),false);
    const reported=await provider.createImageJob([{id:'later',prompt:'Mira waits.'},{id:'bad',prompt:'Rowan waits.'}]);
    gw.complete(reported.job_id,0,'AGAIN');
    gw.fail(reported.job_id,1,'No face found');
    const second=await collectGatewayJob({
      record:{jobId:reported.job_id,panelIds:['later','bad'],fetched:[]},
      poll:()=>provider.imageJobStatus(reported.job_id),
      fetchItem:index=>provider.imageJobItem(reported.job_id,index),
      saveItem:async()=>{},
      deleteJob:()=>provider.deleteImageJob(reported.job_id),
      cancelJob:()=>provider.cancelImageJob(reported.job_id),
      sleep:async()=>{throw Error('should finish');}
    });
    assert.equal(second.errors.find(item=>item.id==='bad').message,'No face found in this panel. Try again.');
    assert.match(explainRequestError(Object.assign(Error(second.errors.find(item=>item.id==='bad').message),{local:true,retryable:true})),/try again/i);
    assert.doesNotMatch(explainRequestError(Object.assign(Error(second.errors.find(item=>item.id==='bad').message),{local:true})),/Venice/);
  }finally{
    globalThis.fetch=original;
    await gw.close();
  }
});

test('a hidden page waits, and showing it polls again immediately', async ()=>{
  const doc=new EventTarget();
  doc.visibilityState='hidden';
  let resolved=false;
  const pending=waitUntilVisible(5000,doc);
  pending.then(()=>{resolved=true;});
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(resolved, false);
  doc.visibilityState='visible';
  doc.dispatchEvent(new Event('visibilitychange'));
  await pending;
  assert.equal(resolved, true);
  doc.visibilityState='visible';
  let sawHidden=false;
  const started=Date.now();
  const again=waitUntilVisible(500,doc).then(()=>{assert.equal(sawHidden,true);assert.equal(doc.visibilityState,'visible');});
  await new Promise(resolve=>setTimeout(resolve,20));
  doc.visibilityState='hidden';
  doc.dispatchEvent(new Event('visibilitychange'));
  sawHidden=true;
  await new Promise(resolve=>setTimeout(resolve,40));
  doc.visibilityState='visible';
  doc.dispatchEvent(new Event('visibilitychange'));
  await again;
  assert.ok(Date.now()-started<400);
  const controller=new AbortController();
  const aborted=waitUntilVisible(5000,doc,controller.signal);
  controller.abort();
  await assert.rejects(aborted,error=>error.cancelled===true);
});

test('the gateway keeps rendering while the phone is gone, then panels land in script order', async ()=>{
  const gw=await startMockGateway();
  const urls=[];
  const original=globalThis.fetch;
  globalThis.fetch=async(url,opts)=>{urls.push(String(url));return original(url,opts);};
  try{
    localStorage.setItem('cs_k','venice-key-should-not-leak');
    localStorage.setItem('cs_local_k',gw.token);
    const provider=new Provider({...defaults,demo:false,localURL:gw.url},async()=>{throw Error('batch approval is not used for a local job');});
    const panels=buildEpisodePages({script,cast:['c1','c2'],count:4,characters:[mira,rowan]}).flatMap(page=>page.panels);
    const built=await buildJobItems(panels,[mira,rowan],'Ink',faces);
    const created=await provider.createImageJob(built.items);
    assert.equal(created.status,'queued');
    assert.equal(created.total,4);
    assert.deepEqual(created.items.map(item=>item.id),built.panelIds);
    const posted=gw.calls.find(call=>call.method==='POST'&&call.path==='/jobs');
    assert.equal(posted.auth,'Bearer '+gw.token);
    assert.deepEqual(posted.body.items.map(item=>item.face_b64),[faceA,undefined,faceB,faceA]);
    assert.equal(gw.calls.find(call=>call.path==='/health').auth,'');
    const record={jobId:created.job_id,panelIds:built.panelIds,fetched:[],startedAt:Date.now()};
    gw.complete(record.jobId,1,'MIDDLE-PANEL');
    const saved=[];
    const delays=[];
    let persisted=null;
    const first=await collectGatewayJob({
      record,
      poll:async()=>{const status=await provider.imageJobStatus(record.jobId);assert.equal(JSON.stringify(status).includes('MIDDLE-PANEL'),false);return status;},
      fetchItem:index=>provider.imageJobItem(record.jobId,index),
      saveItem:async(panelId,image)=>{saved.push({panelId,image});},
      deleteJob:()=>provider.deleteImageJob(record.jobId),
      cancelJob:()=>provider.cancelImageJob(record.jobId),
      sleep:async ms=>{delays.push(ms);return 'stop';},
      onUpdate:async()=>{persisted=structuredClone(record);}
    });
    assert.equal(first.paused,true);
    assert.deepEqual(delays,[3000]);
    assert.deepEqual(saved,[{panelId:built.panelIds[1],image:'MIDDLE-PANEL'}]);
    assert.equal(gw.calls.some(call=>call.method==='DELETE'),false);
    assert.equal(persisted.jobId,created.job_id);
    assert.deepEqual(persisted.fetched,[built.panelIds[1]]);
    gw.complete(record.jobId,2,'THIRD-PANEL');
    gw.complete(record.jobId,0,'FIRST-PANEL');
    gw.complete(record.jobId,3,'FOURTH-PANEL');
    const restored=structuredClone(persisted);
    const secondSaved=[];
    const fetches=[];
    const second=await collectGatewayJob({
      record:restored,
      poll:()=>provider.imageJobStatus(restored.jobId),
      fetchItem:async index=>{fetches.push(index);return provider.imageJobItem(restored.jobId,index);},
      saveItem:async(panelId,image)=>{secondSaved.push({panelId,image});},
      deleteJob:()=>provider.deleteImageJob(restored.jobId),
      cancelJob:()=>provider.cancelImageJob(restored.jobId),
      sleep:async()=>{throw Error('the finished job should not wait for another poll');}
    });
    assert.equal(second.finished,true);
    assert.equal(second.deleted,true);
    assert.equal(second.status,'done');
    assert.deepEqual(secondSaved.map(item=>item.panelId),[built.panelIds[0],built.panelIds[2],built.panelIds[3]]);
    assert.deepEqual(secondSaved.map(item=>item.image),['FIRST-PANEL','THIRD-PANEL','FOURTH-PANEL']);
    assert.deepEqual(fetches,[0,2,3]);
    assert.equal(gw.jobs.has(restored.jobId),false);
    assert.ok(urls.length>0);
    assert.ok(urls.every(url=>url.startsWith(gw.url)));
    assert.equal(JSON.stringify(gw.calls).includes('venice-key-should-not-leak'),false);
    assert.equal(urls.some(url=>/venice\.ai/i.test(url)),false);
  }finally{
    globalThis.fetch=original;
    await gw.close();
  }
});

test('cancel calls the gateway and keeps a panel that already finished', async ()=>{
  const gw=await startMockGateway();
  try{
    localStorage.setItem('cs_local_k',gw.token);
    const provider=new Provider({...defaults,demo:false,localURL:gw.url},async()=>false);
    const created=await provider.createImageJob([{id:'panel-a',prompt:'Mira waits in the garden.'},{id:'panel-b',prompt:'Rowan holds the keys.'}]);
    gw.complete(created.job_id,0,'KEPT');
    const record={jobId:created.job_id,panelIds:['panel-a','panel-b'],fetched:[]};
    let cancel=false;
    const saved=[];
    const result=await collectGatewayJob({
      record,
      poll:()=>provider.imageJobStatus(record.jobId),
      fetchItem:index=>provider.imageJobItem(record.jobId,index),
      saveItem:async(panelId,image)=>{saved.push({panelId,image});cancel=true;},
      deleteJob:()=>provider.deleteImageJob(record.jobId),
      cancelJob:()=>provider.cancelImageJob(record.jobId),
      shouldCancel:()=>cancel,
      sleep:async()=>{}
    });
    assert.equal(result.cancelled,true);
    assert.deepEqual(saved,[{panelId:'panel-a',image:'KEPT'}]);
    assert.equal(record.fetched.includes('panel-b'),false);
    assert.ok(gw.calls.some(call=>call.method==='POST'&&call.path===`/jobs/${created.job_id}/cancel`));
    assert.ok(gw.calls.some(call=>call.method==='DELETE'&&call.path===`/jobs/${created.job_id}`));
    assert.equal(gw.jobs.has(created.job_id),false);
  }finally{await gw.close();}
});

test('a failed panel is reported and a bad token or a sleeping PC can be retried', async ()=>{
  const gw=await startMockGateway();
  try{
    localStorage.setItem('cs_k','venice-key-should-not-leak');
    localStorage.setItem('cs_local_k','wrong-token');
    const provider=new Provider({...defaults,demo:false,localURL:gw.url},async()=>false);
    await assert.rejects(()=>provider.createImageJob([{id:'p',prompt:'Mira waits.'}]),error=>{
      assert.equal(error.status,401);
      assert.equal(error.retryable,true);
      assert.equal(error.local,true);
      assert.match(explainRequestError(error),/token/i);
      assert.match(explainRequestError(error),/try again/i);
      assert.doesNotMatch(explainRequestError(error),/Venice/);
      return true;
    });
    localStorage.setItem('cs_local_k',gw.token);
    const created=await provider.createImageJob([{id:'ok',prompt:'Mira opens the door.'},{id:'bad',prompt:'Rowan waits outside.'}]);
    gw.complete(created.job_id,0,'GOOD');
    gw.fail(created.job_id,1,'Backend image server is unreachable');
    const record={jobId:created.job_id,panelIds:['ok','bad'],fetched:[]};
    const saved=[];
    const result=await collectGatewayJob({
      record,
      poll:()=>provider.imageJobStatus(record.jobId),
      fetchItem:index=>provider.imageJobItem(record.jobId,index),
      saveItem:async(panelId,image)=>{saved.push({panelId,image});},
      deleteJob:()=>provider.deleteImageJob(record.jobId),
      cancelJob:()=>provider.cancelImageJob(record.jobId),
      sleep:async()=>{throw Error('finished job should not poll again');}
    });
    assert.equal(result.status,'error');
    assert.equal(result.deleted,true);
    assert.deepEqual(saved,[{panelId:'ok',image:'GOOD'}]);
    assert.equal(result.errors.find(item=>item.id==='bad').message,'Backend image server is unreachable');
    assert.equal(resolvePanelId(record,result.errors.find(item=>item.id==='bad')),'bad');
    const again=await provider.createImageJob([{id:'later',prompt:'Mira waits.'}]);
    localStorage.setItem('cs_local_k','wrong-token');
    const kept={jobId:again.job_id,panelIds:['later'],fetched:[]};
    await assert.rejects(()=>collectGatewayJob({
      record:kept,
      poll:()=>provider.imageJobStatus(kept.jobId),
      fetchItem:index=>provider.imageJobItem(kept.jobId,index),
      saveItem:async()=>{},
      deleteJob:()=>provider.deleteImageJob(kept.jobId),
      cancelJob:()=>provider.cancelImageJob(kept.jobId),
      sleep:async()=>{}
    }),error=>{
      assert.equal(error.status,401);
      assert.equal(kept.jobId,again.job_id);
      return true;
    });
    localStorage.setItem('cs_local_k',gw.token);
    gw.complete(again.job_id,0,'AFTER-RETRY');
    const retried=[];
    const done=await collectGatewayJob({
      record:kept,
      poll:()=>provider.imageJobStatus(kept.jobId),
      fetchItem:index=>provider.imageJobItem(kept.jobId,index),
      saveItem:async(panelId,image)=>{retried.push({panelId,image});},
      deleteJob:()=>provider.deleteImageJob(kept.jobId),
      cancelJob:()=>provider.cancelImageJob(kept.jobId),
      sleep:async()=>{throw Error('should finish');}
    });
    assert.equal(done.deleted,true);
    assert.deepEqual(retried,[{panelId:'later',image:'AFTER-RETRY'}]);
  }finally{await gw.close();}
  const down=await startMockGateway();
  const url=down.url;
  await down.close();
  localStorage.setItem('cs_local_k','test-local-token');
  const offline=new Provider({...defaults,demo:false,localURL:url},async()=>false);
  await assert.rejects(()=>offline.createImageJob([{id:'p',prompt:'Mira waits.'}]),error=>{
    assert.equal(error.retryable,true);
    assert.equal(error.local,true);
    assert.match(explainRequestError(error),/unreachable|PC/i);
    assert.match(explainRequestError(error),/try again/i);
    assert.doesNotMatch(explainRequestError(error),/Venice/);
    return true;
  });
});

test('an in-progress job id does not change older saved libraries', ()=>{
  const raw={schemaVersion:1,characters:[{id:'c1',age:32,fictional:true,refId:null,name:'Mira Vale',description:'An expressive adult woman with amber eyes.',personality:'Warm',backstory:'A cartographer.',body:'Athletic adult build',hair:'Dark curls',outfit:'Copper jacket',tattoos:'A constellation'}],series:[{id:'s1',title:'After the Last Shuttle',synopsis:'Two grown explorers.',style:'Stylized adult comic art.',episodes:[{id:'e1',title:'Garden',script:'Mira waits in the garden.',previousScript:'',cast:['c1'],imageJob:{jobId:'job-old',panelIds:['p1'],fetched:[]},pages:[{id:'page1',layout:'single',panels:[{id:'p1',cast:['c1'],imageId:null,bubblePosition:'top',captionPosition:'bottom',prompt:'Mira waits.',camera:'Wide shot',dialogue:'',caption:''}]}]}]}]};
  assert.equal(libraryNeedsMigration(raw),true);
  const migrated=migrateLibrary(raw);
  assert.equal(migrated.series[0].episodes[0].imageJob.jobId,'job-old');
  assert.equal(migrated.series[0].episodes[0].pages[0].panels[0].bubbles.length,0);
  const current={...structuredClone(migrated),schemaVersion:2};
  assert.equal(libraryNeedsMigration(current),false);
  const saved=validateLibrary(current);
  assert.equal(saved.series[0].episodes[0].imageJob,undefined);
  assert.equal(saved.series[0].title,'After the Last Shuttle');
  assert.equal(saved.series[0].episodes[0].pages[0].panels[0].prompt,'Mira waits.');
  assert.equal(saved.schemaVersion,2);
});

test('polling stays fast for 30 seconds and then slows', async ()=>{
  const gw=await startMockGateway();
  try{
    localStorage.setItem('cs_local_k',gw.token);
    const provider=new Provider({...defaults,demo:false,localURL:gw.url},async()=>false);
    const created=await provider.createImageJob([{id:'only',prompt:'Mira waits in the garden.'}]);
    let clock=0;
    const delays=[];
    const result=await collectGatewayJob({
      record:{jobId:created.job_id,panelIds:['only'],fetched:[]},
      poll:()=>provider.imageJobStatus(created.job_id),
      fetchItem:index=>provider.imageJobItem(created.job_id,index),
      saveItem:async()=>{},
      deleteJob:()=>provider.deleteImageJob(created.job_id),
      cancelJob:()=>provider.cancelImageJob(created.job_id),
      now:()=>clock,
      sleep:async ms=>{delays.push(ms);clock+=ms;return delays.length>=11?'stop':undefined;}
    });
    assert.equal(result.paused,true);
    assert.deepEqual(delays.slice(0,10),Array(10).fill(3000));
    assert.equal(delays[10],9000);
  }finally{await gw.close();}
});

test('comic sends are split, stay in script order, and a failed send can be retried without Venice', async ()=>{
  const gw=await startMockGateway('test-local-token',{rejectAfter:1});
  const urls=[];
  const original=globalThis.fetch;
  globalThis.fetch=async(url,opts)=>{urls.push(String(url));return original(url,opts);};
  try{
    localStorage.setItem('cs_k','venice-key-should-not-leak');
    localStorage.setItem('cs_local_k',gw.token);
    const provider=new Provider({...defaults,demo:false,localURL:gw.url},async()=>{throw Error('a failed local send must not ask for Venice');});
    const beats=Array.from({length:8},(_,i)=>`Mira crosses the garden, beat ${i+1}.`);
    const panels=buildEpisodePages({script:beats.join('\n\n'),cast:['c1'],count:8,characters:[mira]}).flatMap(page=>page.panels);
    const built=await buildJobItems(panels,[mira],'Ink',faces);
    assert.equal(built.panelIds.length,8);
    const one=jobBodyBytes([built.items[0]]);
    const two=jobBodyBytes(built.items.slice(0,2));
    const budget=two-1;
    assert.ok(budget>=one);
    const record={parts:[],rest:built.panelIds.slice(),startedAt:Date.now()};
    const byId=new Map(built.panelIds.map((id,index)=>[id,built.items[index]]));
    const wire={
      itemFor:async id=>byId.get(id)||null,
      createJob:items=>provider.createImageJob(items),
      poll:async jobId=>{
        const job=gw.jobs.get(jobId);
        job.items.forEach((item,index)=>{if(item.status==='queued')gw.complete(jobId,index,'IMG-'+item.id);});
        return provider.imageJobStatus(jobId);
      },
      fetchItem:(jobId,index)=>provider.imageJobItem(jobId,index),
      deleteJob:jobId=>provider.deleteImageJob(jobId),
      cancelJob:jobId=>provider.cancelImageJob(jobId),
      sleep:async()=>{throw Error('finished parts should not wait');},
      budget
    };
    await assert.rejects(()=>driveImageJobs({record,...wire,saveItem:async()=>{}}),error=>{
      assert.equal(error.local,true);
      assert.equal(error.retryable,true);
      assert.match(explainRequestError(error),/try again/i);
      assert.doesNotMatch(explainRequestError(error),/Venice/);
      return true;
    });
    assert.equal(record.parts.length,1);
    assert.deepEqual(record.parts[0].panelIds.concat(record.rest),built.panelIds);
    assert.equal(record.jobId,record.parts[0].jobId);
    assert.equal(gw.calls.filter(call=>call.method==='POST'&&call.path==='/jobs').length,2);
    gw.control.rejectAfter=null;
    const saved=[];
    const done=await driveImageJobs({
      record,
      ...wire,
      saveItem:async(panelId,image)=>{saved.push({panelId,image});}
    });
    assert.equal(done.finished,true);
    assert.equal(done.deleted,true);
    assert.deepEqual(saved.map(item=>item.panelId),built.panelIds);
    assert.deepEqual(saved.map(item=>item.image),built.panelIds.map(id=>'IMG-'+id));
    assert.ok(gw.calls.filter(call=>call.method==='POST'&&call.path==='/jobs').length>2);
    assert.equal(gw.jobs.size,0);
    assert.equal(urls.some(url=>/venice\.ai/i.test(url)),false);
    assert.equal(JSON.stringify(gw.calls).includes('venice-key-should-not-leak'),false);
    const legacyProvider=provider;
    const legacyPanels=built.panelIds.slice(0,2);
    const legacyItems=legacyPanels.map(id=>byId.get(id));
    const legacyCreated=await legacyProvider.createImageJob(legacyItems);
    const legacy={jobId:legacyCreated.job_id,panelIds:legacyPanels.slice(),fetched:[]};
    assert.equal(hasImageJob(legacy),true);
    assert.equal(normalizeImageJob(legacy).parts[0].jobId,legacyCreated.job_id);
    const legacySaved=[];
    const postsBefore=gw.calls.filter(call=>call.method==='POST'&&call.path==='/jobs').length;
    const resumed=await driveImageJobs({
      record:legacy,
      itemFor:async id=>byId.get(id)||null,
      createJob:()=>{throw Error('an in-progress job should not be sent again');},
      poll:async jobId=>{
        const job=gw.jobs.get(jobId);
        job.items.forEach((item,index)=>{if(item.status==='queued')gw.complete(jobId,index,'OLD-'+item.id);});
        return legacyProvider.imageJobStatus(jobId);
      },
      fetchItem:(jobId,index)=>legacyProvider.imageJobItem(jobId,index),
      saveItem:async(panelId,image)=>{legacySaved.push({panelId,image});},
      deleteJob:jobId=>legacyProvider.deleteImageJob(jobId),
      cancelJob:jobId=>legacyProvider.cancelImageJob(jobId),
      sleep:async()=>{throw Error('should finish');}
    });
    assert.equal(resumed.finished,true);
    assert.deepEqual(legacySaved.map(item=>item.panelId),legacyPanels);
    assert.equal(gw.calls.filter(call=>call.method==='POST'&&call.path==='/jobs').length,postsBefore);
  }finally{
    globalThis.fetch=original;
    await gw.close();
  }
});
