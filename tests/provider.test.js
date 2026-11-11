import test from 'node:test';
import assert from 'node:assert/strict';
import {Provider, defaults, planInstruction, isCancelled} from '../provider.js';

const memory=new Map();
globalThis.localStorage={
  getItem:key=>memory.has(key)?memory.get(key):null,
  setItem:(key,value)=>memory.set(key,String(value)),
  removeItem:key=>memory.delete(key),
  clear:()=>memory.clear()
};

const characters=[{id:'c1',age:32,fictional:true,name:'Mira'}];
const script='Mira waits beside the glass.\n\nRowan smiles at the flowers.\n\nNeither of them is in a hurry.';

test('provider defaults and demo planning do not call the network', async ()=>{
  assert.equal(defaults.panelCount, 45);
  assert.match(planInstruction({}), /maximum 36 panels/);
  assert.match(planInstruction({targetPanels:45}), /exactly 45/);
  let calls=0;
  globalThis.fetch=()=>{calls++;throw Error('network should not be called');};
  const provider=new Provider({...defaults, demo:true}, async()=>{throw Error('demo should not ask');});
  const planned=await provider.text('plan',{script,cast:[{id:'c1'}],targetPanels:45},characters);
  const count=planned.pages.reduce((n,p)=>n+p.panels.length,0);
  assert.equal(count, 45);
  const quick=await provider.text('plan',{script,cast:[{id:'c1'}]},characters);
  const quickCount=quick.pages.reduce((n,p)=>n+p.panels.length,0);
  assert.ok(quickCount>=1&&quickCount<=6);
  assert.equal(calls, 0);
});

test('a normal image still requires approval and a batch can abort before any image returns', async ()=>{
  localStorage.setItem('cs_k','not-a-real-key');
  let calls=0;
  globalThis.fetch=()=>{calls++;throw Error('should not fetch');};
  const declined=new Provider({...defaults, demo:false, localURL:''}, async()=>false, ()=>{});
  await assert.rejects(()=>declined.image('Two fictional adults stand in a garden.',[],[{age:30,fictional:true}]), /Cancelled/);
  assert.equal(calls, 0);
  const controller=new AbortController();
  let fetches=0;
  globalThis.fetch=(url, opts)=>new Promise((_,reject)=>{
    fetches++;
    assert.match(String(url), /^https:\/\/api\.venice\.ai\//);
    const fail=()=>{const error=Error('aborted');error.name='AbortError';reject(error);};
    if(opts.signal.aborted) fail();
    else opts.signal.addEventListener('abort', fail, {once:true});
  });
  const provider=new Provider({...defaults, demo:false, localURL:''}, async()=>{throw Error('batch approval should happen once, outside image()');});
  const pending=provider.image('Two fictional adults stand in a garden.',[],[{age:30,fictional:true}],{approved:true,signal:controller.signal});
  await new Promise(resolve=>setTimeout(resolve, 20));
  controller.abort();
  await assert.rejects(pending, error=>isCancelled(error));
  assert.equal(fetches, 1);
});
