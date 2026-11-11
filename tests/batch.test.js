import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_PANEL_COUNT, clampPanelCount, splitScriptIntoBeats, buildEpisodePages, normalizePlan, panelJob, panelPrompt, characterSeed, PLAN_MAX_PANELS} from '../core.js';
import {runPanelBatch} from '../batch.js';

const script=Array.from({length:20},(_,i)=>`Scene ${i+1}. Mira and Rowan, both fictional adults, keep walking through the orbital garden.`).join('\n\n');

test('panel count defaults to 45 and clamps into the episode limit', ()=>{
  assert.equal(DEFAULT_PANEL_COUNT, 45);
  assert.equal(clampPanelCount(undefined), 45);
  assert.equal(clampPanelCount('45'), 45);
  assert.equal(clampPanelCount(1.6), 2);
  assert.equal(clampPanelCount(0), 1);
  assert.equal(clampPanelCount(80), 72);
});

test('a script becomes exactly 45 ordered beats and pages', ()=>{
  const beats=splitScriptIntoBeats(script, 45);
  assert.equal(beats.length, 45);
  assert.ok(beats.every(b=>b.prompt.trim()&&b.camera));
  const blob=beats.map(b=>b.prompt).join('\n');
  let last=0;
  for(let i=1;i<=20;i++){
    const at=blob.indexOf(`Scene ${i}`);
    assert.ok(at>=last, `scene ${i} missing or out of order`);
    last=at;
  }
  const pages=buildEpisodePages({script, cast:['c1','c2'], count:45});
  const panels=pages.flatMap(p=>p.panels);
  assert.equal(panels.length, 45);
  assert.equal(pages.length, 8);
  assert.equal(pages[0].layout, 'hero');
  assert.equal(pages.at(-1).panels.length, 3);
  assert.ok(pages.every(p=>p.panels.length<=6&&p.panels.length>=1));
  assert.ok(panels.every(p=>p.cast.includes('c1')&&Array.isArray(p.bubbles)&&p.imageId===null));
});

test('short scripts still fill the requested panel count', ()=>{
  const beats=splitScriptIntoBeats('Mira waits in the garden.', 45);
  assert.equal(beats.length, 45);
  assert.ok(beats.every(b=>/Mira waits/.test(b.prompt)));
});

test('quick plan stays capped at 36 while a full comic can use a short AI plan as hints', ()=>{
  const raw={pages:Array.from({length:10},()=>({layout:'two',panels:Array.from({length:4},()=>({prompt:'An adult waits.',camera:'Wide shot',dialogue:'',caption:'',cast:['c1']}))}))};
  assert.equal(PLAN_MAX_PANELS, 36);
  assert.throws(()=>normalizePlan(raw,['c1']), /36/);
  const pages=buildEpisodePages({
    script,
    cast:['c1'],
    count:45,
    plan:{pages:[{layout:'two',panels:[{prompt:'Amber light through the glass canopy.',camera:'Low angle',dialogue:'Mira: Stay.',caption:'',cast:['nope','c1']}]}]}
  });
  const panels=pages.flatMap(p=>p.panels);
  assert.equal(panels.length, 45);
  assert.match(panels[0].prompt, /Amber light/);
  assert.equal(panels[0].camera, 'Low angle');
  assert.deepEqual(panels[0].cast, ['c1']);
  assert.match(panels[10].prompt, /garden|Mira|Rowan|Scene|fictional/);
});

test('disallowed model text is dropped and a disallowed script still fails', ()=>{
  const pages=buildEpisodePages({
    script:'Mira, age 32, waits beside Rowan, age 35.',
    cast:['c1'],
    count:4,
    plan:{pages:[{layout:'single',panels:[{prompt:'a child walks in',camera:'Close-up',dialogue:'',caption:''}]}]}
  });
  assert.doesNotMatch(pages[0].panels[0].prompt, /child/i);
  assert.match(pages[0].panels[0].prompt, /Mira/);
  assert.throws(()=>buildEpisodePages({script:'A child walks in.',cast:['c1'],count:4}), /Adults only|18/);
  assert.throws(()=>splitScriptIntoBeats('   ', 45), /Write your episode/);
});

test('generate comic keeps script order and the cast named in each panel', ()=>{
  const script=[
    'Mira opens the kitchen door.',
    'The kitchen is quiet.',
    'Rowan stands outside with the keys.',
    'Mira hands Rowan the box.'
  ].join('\n\n');
  const characters=[{id:'c1',name:'Mira'},{id:'c2',name:'Rowan'}];
  const pages=buildEpisodePages({
    script,
    cast:['c1','c2'],
    count:4,
    characters,
    plan:{pages:[{layout:'single',panels:[{prompt:'A stranger waves.',camera:'Wide shot',dialogue:'',caption:'',cast:['c2']}]}]}
  });
  const panels=pages.flatMap(p=>p.panels);
  assert.equal(panels.length, 4);
  assert.match(panels[0].prompt, /stranger/);
  assert.deepEqual(panels[0].cast, ['c1']);
  assert.match(panels[1].prompt, /quiet/);
  assert.deepEqual(panels[1].cast, ['c1','c2']);
  assert.match(panels[2].prompt, /keys/);
  assert.deepEqual(panels[2].cast, ['c2']);
  assert.match(panels[3].prompt, /box/);
  assert.deepEqual(panels[3].cast, ['c1','c2']);
  const blob=panels.map(p=>p.prompt).join('\n');
  assert.ok(blob.indexOf('quiet')<blob.indexOf('keys'));
  assert.ok(blob.indexOf('keys')<blob.indexOf('box'));
});

test('image prompts lead with identity and keep it when the scene is shortened', ()=>{
  const mira={id:'a',name:'Mira',age:32,description:'amber eyes and a silver eyebrow piercing',hair:'dark curls in a loose bun',body:'athletic adult build',outfit:'copper flight jacket',tattoos:'CONSTELLATIONTATTOO on the left forearm',personality:'THIS_PERSONALITY_SHOULD_NOT_APPEAR',backstory:'THIS_BACKSTORY_SHOULD_NOT_APPEAR',refId:'ref-a'};
  const rowan={id:'b',name:'Rowan',age:35,description:'green eyes',hair:'short black hair',body:'broad shoulders',outfit:'charcoal coat',tattoos:'leaf on the wrist',refId:'ref-b'};
  const scene=`Garden path. ${'walking further '.repeat(400)}ZEBRAEND`;
  const prompt=panelPrompt({style:'Ink',camera:'Close-up, three-quarter view',scene,characters:[mira],limit:1200});
  assert.ok(prompt.length<=1200);
  assert.match(prompt, /^Exact character identity/);
  assert.match(prompt, /CONSTELLATIONTATTOO/);
  assert.match(prompt, /dark curls in a loose bun/);
  assert.match(prompt, /silver eyebrow piercing/);
  assert.match(prompt, /Scene:/);
  assert.ok(prompt.indexOf('Exact character identity')<prompt.indexOf('Scene:'));
  assert.doesNotMatch(prompt, /THIS_PERSONALITY_SHOULD_NOT_APPEAR/);
  assert.doesNotMatch(prompt, /THIS_BACKSTORY_SHOULD_NOT_APPEAR/);
  assert.doesNotMatch(prompt, /ZEBRAEND/);
  assert.throws(()=>panelPrompt({characters:[{name:'Mira',age:32,description:'x'.repeat(4000)}],limit:500}), /appearance is longer/);
  const job=panelJob({cast:['b','a'],prompt:'Rowan looks back.',camera:'Close-up'}, [mira,rowan], 'Painted light', {limit:7500});
  assert.deepEqual(job.referenceIds, ['ref-b','ref-a']);
  assert.equal(job.seed, characterSeed('b|a'));
  assert.equal(job.seed, panelJob({cast:['b','a'],prompt:'Again.',camera:'Wide'}, [mira,rowan], 'Painted light').seed);
  assert.notEqual(job.seed, characterSeed('a'));
  assert.ok(job.seed>=1&&job.seed<=999999999);
  assert.ok(job.prompt.indexOf('Rowan')<job.prompt.indexOf('Mira'));
  assert.ok(job.prompt.startsWith('Exact character identity'));
});

test('panel jobs reuse only the selected character references', ()=>{
  const chars=[
    {id:'a',name:'Mira',age:32,description:'An adult woman',refId:'ref-a',body:'',hair:'',outfit:'',tattoos:'',personality:'',backstory:''},
    {id:'b',name:'Rowan',age:35,description:'An adult man',refId:'ref-b',body:'',hair:'',outfit:'',tattoos:'',personality:'',backstory:''},
    {id:'c',name:'No Ref',age:40,description:'An adult',refId:null,body:'',hair:'',outfit:'',tattoos:'',personality:'',backstory:''}
  ];
  const job=panelJob({cast:['a','c'],prompt:'They share a look.',camera:'Medium shot, eye level'}, chars, 'Painted light');
  assert.deepEqual(job.referenceIds, ['ref-a']);
  assert.match(job.prompt, /Mira/);
  assert.match(job.prompt, /No Ref/);
  assert.doesNotMatch(job.prompt, /Rowan/);
  assert.match(job.prompt, /no printed text, captions, or speech bubbles/);
  assert.match(job.prompt, /fictional adults, age 18\+/);
});

test('batch generation skips finished panels, records failures, and can resume', async ()=>{
  const panels=[{id:'a',imageId:'done'},{id:'b',imageId:null},{id:'c',imageId:null}];
  const calls=[];
  const first=await runPanelBatch({
    panels,
    generate:async p=>{calls.push(p.id);if(p.id==='c')throw Error('render failed');return {ok:p.id};},
    save:async p=>'img-'+p.id
  });
  assert.deepEqual(calls, ['b','c']);
  assert.equal(panels[0].imageId, 'done');
  assert.equal(panels[1].imageId, 'img-b');
  assert.equal(panels[2].imageId, null);
  assert.match(panels[2].genError, /render failed/);
  assert.equal(first.completed, 2);
  assert.equal(first.failed, 1);
  calls.length=0;
  const second=await runPanelBatch({
    panels,
    generate:async p=>{calls.push(p.id);return {ok:true};},
    save:async p=>'img-'+p.id
  });
  assert.deepEqual(calls, ['c']);
  assert.equal(panels[2].imageId, 'img-c');
  assert.equal(second.completed, 3);
  assert.equal(second.failed, 0);
});

test('cancelling stops the sequence and keeps panels already saved', async ()=>{
  const panels=[{id:'a'},{id:'b'},{id:'c'}];
  const calls=[];
  let stop=false;
  const progress=[];
  const result=await runPanelBatch({
    panels,
    shouldCancel:()=>stop,
    generate:async p=>{calls.push(p.id);stop=true;return {ok:true};},
    save:async()=>'kept',
    onProgress:info=>progress.push(`${info.completed}/${info.total}`)
  });
  assert.equal(result.cancelled, true);
  assert.deepEqual(calls, ['a']);
  assert.equal(panels[0].imageId, 'kept');
  assert.equal(panels[1].imageId, undefined);
  assert.ok(progress.some(line=>line==='1/3'));
  const blown=[{id:'a'},{id:'b'}];
  const seen=[];
  const mid=await runPanelBatch({
    panels:blown,
    generate:async p=>{seen.push(p.id);if(p.id==='b'){const e=Error('Cancelled.');e.cancelled=true;throw e;}return {};},
    save:async()=>'yes'
  });
  assert.equal(mid.cancelled, true);
  assert.deepEqual(seen, ['a','b']);
  assert.equal(blown[0].imageId, 'yes');
  assert.equal(blown[1].imageId, undefined);
});
