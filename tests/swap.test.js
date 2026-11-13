import test from 'node:test';
import assert from 'node:assert/strict';
import {assetIds} from '../core.js';
import {SWAP_ITEM_LIMIT, SWAP_JPEG_QUALITY, prepareSwapTarget, jobBodyBytes} from '../face.js';
import {Provider, defaults, explainRequestError} from '../provider.js';
import {buildSwapItems, canFaceSwap, collectGatewayJob, describeSwapSkip, driveImageJobs, noSwapMessage, panelSourceLabel, splitJobItems} from '../jobs.js';
import {startMockGateway} from './mock-gateway.js';

const memory=new Map();
globalThis.localStorage={
  getItem:key=>memory.has(key)?memory.get(key):null,
  setItem:(key,value)=>memory.set(key,String(value)),
  removeItem:key=>memory.delete(key),
  clear:()=>memory.clear()
};

const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const face='A'.repeat(64);
const mira={id:'c1',name:'Mira Vale',age:32,fictional:true,description:'amber eyes and warm brown skin',hair:'dark curls',body:'athletic adult build',outfit:'copper jacket',tattoos:'a constellation on the left forearm',personality:'warm',backstory:'a cartographer',refId:'ref-mira'};
const rowan={id:'c2',name:'Rowan Ash',age:35,fictional:true,description:'green eyes',hair:'short black hair',body:'broad shoulders',outfit:'charcoal coat',tattoos:'a leaf on the wrist',personality:'patient',backstory:'a gardener',refId:null};

test('face swap is opt-in and labels say why a panel stayed Venice', ()=>{
  assert.equal(SWAP_JPEG_QUALITY, 0.9);
  assert.equal(SWAP_ITEM_LIMIT, 3*1024*1024);
  assert.equal(defaults.drawOnPc, false);
  assert.equal(canFaceSwap({demo:true,localURL:'https://pc.example',drawOnPc:false}, 'token'), false);
  assert.equal(canFaceSwap({demo:false,localURL:'https://pc.example',drawOnPc:true}, 'token'), false);
  assert.equal(canFaceSwap({demo:false,localURL:'https://pc.example',drawOnPc:false}, ''), false);
  assert.equal(canFaceSwap({demo:false,localURL:'https://pc.example'}, 'token'), true);
  const named={id:'p1',prompt:'Mira Vale waits by the glass.',camera:'Medium shot',cast:['c1'],dialogue:'',caption:''};
  const quiet={id:'p2',prompt:'The kitchen is quiet.',camera:'Wide shot',cast:['c1'],dialogue:'',caption:''};
  const bare={id:'p3',prompt:'Rowan Ash waits outside.',camera:'Close-up',cast:['c2'],dialogue:'',caption:''};
  assert.equal(describeSwapSkip(quiet,[mira],{serverOn:true}), 'no-character');
  assert.equal(describeSwapSkip(bare,[rowan],{serverOn:true}), 'no-reference');
  assert.equal(describeSwapSkip(named,[mira],{serverOn:false}), 'server-off');
  assert.equal(describeSwapSkip(named,[mira],{serverOn:true,faceSwap:false}), 'no-faceswap');
  assert.equal(describeSwapSkip(named,[mira],{serverOn:true,faceSwap:true}), '');
  assert.equal(panelSourceLabel({engine:'swapped',view:'swapped'}), 'Venice + PC face');
  assert.equal(panelSourceLabel({engine:'swapped',view:'original'}), 'Venice · original');
  assert.equal(panelSourceLabel({engine:'venice',swapNote:'no-character'}), 'Venice · no character');
  assert.equal(panelSourceLabel({engine:'venice',swapNote:'no-reference'}), 'Venice · no reference');
  assert.equal(panelSourceLabel({engine:'venice',swapNote:'server-off'}), 'Venice · server off');
  assert.equal(panelSourceLabel({engine:'venice',swapNote:'unswapped'}), 'Venice · unswapped');
  assert.equal(panelSourceLabel({engine:'venice',swapNote:'no-faceswap'}), 'Venice');
  assert.equal(panelSourceLabel({engine:'local'}), 'PC face match');
  assert.equal(panelSourceLabel({engine:'venice'}), 'Venice');
});

test('a small Venice image is sent as-is and an oversized one is refused without a browser', async ()=>{
  const prepared=await prepareSwapTarget(PNG, face, 'panel-1');
  assert.equal(prepared, PNG);
  const item={type:'swap',id:'panel-1',target_b64:prepared,face_b64:face};
  assert.ok(jobBodyBytes([item])<=SWAP_ITEM_LIMIT);
  assert.equal(item.target_index, undefined);
  const huge=Buffer.concat([Buffer.from(PNG,'base64'), Buffer.alloc(SWAP_ITEM_LIMIT)]).toString('base64');
  await assert.rejects(()=>prepareSwapTarget(huge, face, 'panel-1'), /too large|compress/i);
});

test('swap items keep script order and the direct faceswap call uses the local token', async ()=>{
  const panels=[
    {id:'p-mira',prompt:'Mira Vale opens the kitchen door.',camera:'Medium shot',cast:['c1'],dialogue:'',caption:''},
    {id:'p-quiet',prompt:'The kitchen is quiet.',camera:'Wide shot',cast:['c1','c2'],dialogue:'',caption:''},
    {id:'p-rowan',prompt:'Rowan Ash stands outside.',camera:'Close-up',cast:['c2'],dialogue:'',caption:''}
  ];
  const built=await buildSwapItems(panels,[mira,rowan], async panel=>panel.id==='p-rowan'?null:PNG, async id=>id==='ref-mira'?`data:image/jpeg;base64,${face}`:'');
  assert.deepEqual(built.panelIds, ['p-mira']);
  assert.equal(built.items[0].type, 'swap');
  assert.equal(built.items[0].face_b64, face);
  assert.equal(built.items[0].target_b64, PNG);
  assert.equal(built.items[0].target_index, undefined);
  assert.deepEqual(built.skipped.map(skip=>skip.reason), ['no-character','no-reference']);
  const gw=await startMockGateway('pc-token');
  const urls=[];
  const original=globalThis.fetch;
  globalThis.fetch=async(url,opts)=>{urls.push(String(url)+' '+(opts.headers?.Authorization||''));return original(url,opts);};
  try{
    localStorage.setItem('cs_k','venice-key-should-not-leak');
    localStorage.setItem('cs_local_k', gw.token);
    const provider=new Provider({...defaults,demo:false,localURL:gw.url,drawOnPc:false}, async()=>{throw Error('face swap must not ask Venice');});
    const swapped=await provider.faceSwap(built.items[0]);
    assert.equal(swapped.swapped, 1);
    assert.match(swapped.image_b64, /^iVBOR/);
    const call=gw.calls.find(entry=>entry.path==='/faceswap');
    assert.equal(call.method, 'POST');
    assert.equal(call.auth, 'Bearer '+gw.token);
    assert.equal(call.body.target_b64, PNG);
    assert.equal(call.body.face_b64, face);
    assert.equal(call.body.type, undefined);
    assert.equal(JSON.stringify(gw.calls).includes('venice-key-should-not-leak'), false);
    assert.equal(urls.some(url=>/venice\.ai/i.test(url)), false);
    gw.control.swapFail='noface';
    await assert.rejects(()=>provider.faceSwap(built.items[0]), error=>{
      assert.equal(error.status, 422);
      assert.equal(error.local, true);
      assert.match(explainRequestError(error), /No face found/);
      assert.match(explainRequestError(error), /try again/i);
      assert.doesNotMatch(explainRequestError(error), /Venice/);
      return true;
    });
  }finally{
    globalThis.fetch=original;
    await gw.close();
  }
});

test('a comic swap job resumes in script order and a missing faceswap ability is not a Venice call', async ()=>{
  const gw=await startMockGateway('pc-token');
  const urls=[];
  const original=globalThis.fetch;
  globalThis.fetch=async(url,opts)=>{urls.push(String(url));return original(url,opts);};
  try{
    localStorage.setItem('cs_k','venice-key-should-not-leak');
    localStorage.setItem('cs_local_k', gw.token);
    const provider=new Provider({...defaults,demo:false,localURL:gw.url}, async()=>{throw Error('jobs must not ask Venice');});
    const health=await provider.localHealth();
    assert.equal(health.faceswap, true);
    assert.equal(health.ok, true);
    const items=[
      {type:'swap',id:'first',target_b64:PNG,face_b64:face},
      {type:'swap',id:'second',target_b64:PNG,face_b64:face}
    ];
    assert.deepEqual(splitJobItems(items, SWAP_ITEM_LIMIT).map(chunk=>chunk.map(item=>item.id)), [['first','second']]);
    const created=await provider.createSwapJob(items);
    const posted=gw.calls.filter(call=>call.method==='POST'&&call.path==='/jobs').at(-1);
    assert.deepEqual(posted.body.items.map(item=>item.type), ['swap','swap']);
    assert.equal(posted.auth, 'Bearer '+gw.token);
    gw.complete(created.job_id, 1, 'SECOND');
    const record={kind:'swap',jobId:created.job_id,panelIds:['first','second'],fetched:[],startedAt:Date.now()};
    const saved=[];
    const paused=await collectGatewayJob({
      record,
      poll:()=>provider.imageJobStatus(record.jobId),
      fetchItem:index=>provider.imageJobItem(record.jobId, index),
      saveItem:async(panelId,image)=>{saved.push({panelId,image});},
      deleteJob:()=>provider.deleteImageJob(record.jobId),
      cancelJob:()=>provider.cancelImageJob(record.jobId),
      sleep:async()=>'stop'
    });
    assert.equal(paused.paused, true);
    assert.deepEqual(saved, [{panelId:'second',image:'SECOND'}]);
    gw.complete(created.job_id, 0, 'FIRST');
    const done=await collectGatewayJob({
      record,
      poll:()=>provider.imageJobStatus(record.jobId),
      fetchItem:index=>provider.imageJobItem(record.jobId, index),
      saveItem:async(panelId,image)=>{saved.push({panelId,image});},
      deleteJob:()=>provider.deleteImageJob(record.jobId),
      cancelJob:()=>provider.cancelImageJob(record.jobId),
      sleep:async()=>{throw Error('finished swap job should not wait');}
    });
    assert.equal(done.finished, true);
    assert.deepEqual(saved.map(item=>item.panelId), ['second','first']);
    const zero=await provider.createSwapJob([{type:'swap',id:'none',target_b64:PNG,face_b64:face}]);
    gw.complete(zero.job_id, 0, PNG, {swapped:0});
    const missed=await collectGatewayJob({
      record:{jobId:zero.job_id,panelIds:['none'],fetched:[]},
      poll:()=>provider.imageJobStatus(zero.job_id),
      fetchItem:index=>provider.imageJobItem(zero.job_id, index),
      saveItem:async()=>{throw Error('a zero swap must not replace the Venice image');},
      deleteJob:()=>provider.deleteImageJob(zero.job_id),
      cancelJob:()=>provider.cancelImageJob(zero.job_id),
      sleep:async()=>{throw Error('should finish');}
    });
    assert.equal(missed.errors[0].message, noSwapMessage());
    assert.equal(urls.some(url=>/venice\.ai/i.test(url)), false);
    assert.equal(JSON.stringify(gw.calls).includes('venice-key-should-not-leak'), false);
  }finally{
    globalThis.fetch=original;
    await gw.close();
  }
  const plain=await startMockGateway('pc-token', {faceswap:false});
  try{
    localStorage.setItem('cs_local_k', plain.token);
    const provider=new Provider({...defaults,demo:false,localURL:plain.url}, async()=>false);
    const health=await provider.localHealth();
    assert.equal(health.ok, true);
    assert.equal(health.faceswap, undefined);
    await assert.rejects(()=>provider.createSwapJob([{type:'swap',id:'p',target_b64:PNG,face_b64:face}]), error=>{
      assert.equal(error.noFaceSwap, true);
      assert.equal(error.local, true);
      assert.match(error.message, /does not offer face swap/i);
      return true;
    });
    assert.equal(plain.calls.some(call=>call.method==='POST'&&call.path==='/jobs'), false);
  }finally{
    await plain.close();
  }
});

test('a failed swap upload can be retried without asking Venice', async ()=>{
  const gw=await startMockGateway('pc-token', {rejectAfter:0});
  const urls=[];
  const original=globalThis.fetch;
  globalThis.fetch=async(url,opts)=>{urls.push(String(url));return original(url,opts);};
  try{
    localStorage.setItem('cs_k','venice-key-should-not-leak');
    localStorage.setItem('cs_local_k', gw.token);
    const provider=new Provider({...defaults,demo:false,localURL:gw.url}, async()=>{throw Error('retry must not ask Venice');});
    const items=[{type:'swap',id:'only',target_b64:PNG,face_b64:face}];
    const record={kind:'swap',parts:[],rest:['only'],startedAt:Date.now()};
    await assert.rejects(()=>driveImageJobs({
      record,
      budget:SWAP_ITEM_LIMIT,
      itemFor:async()=>items[0],
      createJob:batch=>provider.createSwapJob(batch),
      poll:()=>provider.imageJobStatus('missing'),
      fetchItem:()=>{throw Error('should not fetch');},
      saveItem:async()=>{},
      deleteJob:()=>{},
      cancelJob:()=>{},
      sleep:async()=>{}
    }), error=>{
      assert.equal(error.local, true);
      assert.equal(error.retryable, true);
      assert.match(explainRequestError(error), /try again/i);
      assert.doesNotMatch(explainRequestError(error), /Venice/);
      return true;
    });
    assert.equal(record.kind, 'swap');
    gw.control.rejectAfter=null;
    const saved=[];
    const done=await driveImageJobs({
      record,
      budget:SWAP_ITEM_LIMIT,
      itemFor:async()=>items[0],
      createJob:async batch=>{
        const created=await provider.createSwapJob(batch);
        gw.complete(created.job_id, 0, 'SWAPPED');
        return created;
      },
      poll:jobId=>provider.imageJobStatus(jobId),
      fetchItem:(jobId,index)=>provider.imageJobItem(jobId, index),
      saveItem:async(panelId,image)=>{saved.push({panelId,image});},
      deleteJob:jobId=>provider.deleteImageJob(jobId),
      cancelJob:jobId=>provider.cancelImageJob(jobId),
      sleep:async()=>{throw Error('should finish');}
    });
    assert.equal(done.finished, true);
    assert.deepEqual(saved, [{panelId:'only',image:'SWAPPED'}]);
    assert.equal(urls.some(url=>/venice\.ai/i.test(url)), false);
  }finally{
    globalThis.fetch=original;
    await gw.close();
  }
  const lib={characters:[],series:[{episodes:[{pages:[{panels:[{imageId:'shown',veniceId:'original',swapId:'swapped'}]}]}]}]};
  assert.deepEqual(assetIds(lib).sort(), ['original','shown','swapped']);
});
