import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_PANEL_COUNT, clampPanelCount, splitScriptIntoBeats, buildEpisodePages, normalizePlan, panelJob, panelPrompt, visualScene, characterSeed, PLAN_MAX_PANELS} from '../core.js';
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

test('a script keeps every sentence in order and does not invent panels', ()=>{
  const beats=splitScriptIntoBeats(script);
  assert.equal(beats.length, 40);
  assert.ok(beats.every(b=>b.camera));
  const blob=beats.map(b=>b.prompt).join('\n');
  let last=-1;
  for(let i=1;i<=20;i++){
    const at=blob.indexOf(`Scene ${i}`);
    assert.ok(at>last, `scene ${i} missing or out of order`);
    last=at;
  }
  assert.doesNotMatch(blob, /Story beat/);
  const pages=buildEpisodePages({script, cast:['c1','c2'], characters:[{id:'c1',name:'Mira'},{id:'c2',name:'Rowan'}]});
  const panels=pages.flatMap(p=>p.panels);
  assert.equal(panels.length, 40);
  assert.equal(pages.length, 7);
  assert.equal(pages[0].layout, 'hero');
  assert.equal(pages.at(-1).panels.length, 4);
  assert.ok(pages.every(p=>p.panels.length<=6&&p.panels.length>=1));
  assert.ok(panels.every(p=>Array.isArray(p.bubbles)&&p.imageId===null));
});

test('a short script stays one panel', ()=>{
  const beats=splitScriptIntoBeats('Mira waits in the garden.');
  assert.equal(beats.length, 1);
  assert.match(beats[0].prompt, /Mira waits in the garden/);
});

test('an optional plan cannot replace her scene text', ()=>{
  const raw={pages:Array.from({length:10},()=>({layout:'two',panels:Array.from({length:4},()=>({prompt:'An adult waits.',camera:'Wide shot',dialogue:'',caption:'',cast:['c1']}))}))};
  assert.equal(PLAN_MAX_PANELS, 36);
  assert.throws(()=>normalizePlan(raw,['c1']), /36/);
  const pages=buildEpisodePages({
    script,
    cast:['c1'],
    characters:[{id:'c1',name:'Mira'}],
    plan:{pages:[{layout:'two',panels:[{prompt:'Amber light through the glass canopy.',camera:'Low angle',dialogue:'Mira: Stay.',caption:'',cast:['nope','c1']}]}]}
  });
  const panels=pages.flatMap(p=>p.panels);
  assert.equal(panels.length, 40);
  assert.doesNotMatch(panels[0].prompt, /Amber light|Stay/);
  assert.match(panels[0].prompt, /Scene 1/);
  assert.equal(panels[0].dialogue, '');
  assert.equal(panels[0].caption, '');
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
  assert.match(panels[0].prompt, /Mira opens the kitchen door/);
  assert.doesNotMatch(panels.map(p=>p.prompt).join('\n'), /stranger|A stranger/);
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

test('image prompts lead with the scene and shorten only an extremely long scene', ()=>{
  const mira={id:'a',name:'Mira',age:32,description:'amber eyes and a silver eyebrow piercing',hair:'dark curls in a loose bun',body:'athletic adult build',outfit:'copper flight jacket',tattoos:'CONSTELLATIONTATTOO on the left forearm',personality:'THIS_PERSONALITY_SHOULD_NOT_APPEAR',backstory:'THIS_BACKSTORY_SHOULD_NOT_APPEAR',refId:'ref-a'};
  const rowan={id:'b',name:'Rowan',age:35,description:'green eyes',hair:'short black hair',body:'broad shoulders',outfit:'charcoal coat',tattoos:'leaf on the wrist',refId:'ref-b'};
  const scene=`Garden path. ${'walking further '.repeat(400)}ZEBRAEND`;
  const prompt=panelPrompt({style:'Ink',camera:'Close-up, three-quarter view',scene,characters:[mira],limit:1200});
  assert.ok(prompt.length<=1200);
  assert.match(prompt, /^A cinematic 3D animated film still of grown adults in their 30s with mature adult faces: defined cheekbones and jawlines, adult facial structure, natural adult proportions, detailed realistic skin/);
  assert.doesNotMatch(prompt, /\bcomic\b|lettering|speech bubble|word balloon/i);
  assert.match(prompt, /Camera: Close-up, three-quarter view/);
  assert.match(prompt, /Scene: Garden path/);
  assert.ok(prompt.indexOf('Scene:')<prompt.indexOf('Characters,'));
  assert.match(prompt, /dark curls in a loose bun/);
  assert.match(prompt, /CONSTELLATIONTATTOO/);
  assert.doesNotMatch(prompt, /THIS_PERSONALITY_SHOULD_NOT_APPEAR/);
  assert.doesNotMatch(prompt, /THIS_BACKSTORY_SHOULD_NOT_APPEAR/);
  assert.doesNotMatch(prompt, /ZEBRAEND/);
  const plain=panelPrompt({style:'Ink',camera:'Wide establishing shot',scene:'Mira waits by the glass.',characters:[mira],limit:7500});
  assert.match(plain, /silver eyebrow piercing/);
  assert.match(plain, /copper flight jacket/);
  assert.match(plain, /Scene: Mira waits by the glass/);
  const dressed=panelPrompt({style:'Ink',camera:'Medium shot, eye level',scene:'Mira waits by the glass in a red dress.',characters:[mira],limit:7500});
  assert.match(dressed, /red dress/);
  assert.doesNotMatch(dressed, /copper flight jacket/);
  assert.match(dressed, /Do not depict nudity/);
  const nudeSaved=panelPrompt({style:'Ink',camera:'Medium shot, eye level',scene:'Mira waits by the glass.',characters:[{...mira,outfit:'nude'}],limit:7500});
  assert.doesNotMatch(nudeSaved, /\bnude\b/i);
  assert.match(nudeSaved, /Do not depict nudity/);
  const nudeScene=panelPrompt({style:'Ink',camera:'Medium shot, eye level',scene:'Mira stands in the bedroom, nude.',characters:[mira],limit:7500});
  assert.match(nudeScene, /Scene: Mira stands in the bedroom, nude/);
  assert.doesNotMatch(nudeScene, /Do not depict nudity/);
  assert.doesNotMatch(nudeScene, /copper flight jacket/);
  const crowded=panelPrompt({characters:[{name:'Mira',age:32,description:'x'.repeat(4000)}],limit:500});
  assert.ok(crowded.length<=500);
  assert.doesNotMatch(crowded, /x{80}/);
  assert.match(crowded, /Mira/);
  const job=panelJob({cast:['b','a'],prompt:'Rowan looks back at Mira.',camera:'Close-up'}, [mira,rowan], 'Painted light', {limit:7500});
  assert.deepEqual(job.referenceIds, ['ref-b','ref-a']);
  assert.equal(job.seed, characterSeed('b|a'));
  assert.equal(job.seed, panelJob({cast:['b','a'],prompt:'Rowan looks back at Mira.',camera:'Wide'}, [mira,rowan], 'Painted light').seed);
  assert.notEqual(job.seed, characterSeed('a'));
  assert.ok(job.seed>=1&&job.seed<=999999999);
  assert.ok(job.prompt.indexOf('Rowan')<job.prompt.indexOf('Mira'));
  assert.match(job.prompt, /^A cinematic 3D animated film still/);
  assert.doesNotMatch(job.prompt, /\bcomic\b|lettering|speech bubble/i);
  const onlyRowan=panelJob({cast:['b','a'],prompt:'Rowan looks back.',camera:'Close-up'}, [mira,rowan], 'Painted light');
  assert.deepEqual(onlyRowan.referenceIds, ['ref-b']);
  assert.equal(onlyRowan.seed, characterSeed('b'));
  assert.match(onlyRowan.prompt, /Rowan/);
  assert.doesNotMatch(onlyRowan.prompt, /Mira/);
  const spoken=panelPrompt({style:'Ink',camera:'Wide establishing shot',scene:'Mira Vale: "Stay with me tonight." She says "Wait." She asks if he is coming. She turns toward the window.',characters:[mira]});
  assert.doesNotMatch(spoken, /Stay with me|Wait|says|asks/);
  assert.match(spoken, /turns toward the window/);
  assert.doesNotMatch(spoken, /speech bubble|word balloon|\bcomic\b|lettering/i);
  assert.match(spoken, /cinematic 3D animated film still/);
  assert.equal(visualScene('Mira: Stay with me.\nShe waits by the glass.'), 'She waits by the glass.');
  assert.equal(visualScene('She says "Stay with me tonight." She turns toward the window.'), 'She turns toward the window.');
  const pagesFromSpeech=buildEpisodePages({script:'Mira: Stay with me tonight.\n\nShe turns toward the window.',cast:['a'],characters:[mira]});
  const speechPanels=pagesFromSpeech.flatMap(p=>p.panels);
  assert.equal(speechPanels.length, 2);
  assert.equal(speechPanels[0].bubbles[0].text, 'Stay with me tonight.');
  assert.equal(speechPanels[0].bubbles[0].preset, 'round-speech');
  assert.equal(speechPanels[1].bubbles.length, 0);
  assert.doesNotMatch(speechPanels.map(p=>p.prompt).join('\n'), /Stay with me/);
  assert.match(speechPanels[1].prompt, /turns toward the window/);
});

test('five beats stay five panels in her order', ()=>{
  const five=[
    'Mira opens the kitchen door.',
    'The kitchen is quiet.',
    'Rowan stands outside with the keys.',
    'Mira hands Rowan the box.',
    'They sit down together.'
  ];
  const pages=buildEpisodePages({script:five.join('\n\n'),cast:['a','b'],characters:[{id:'a',name:'Mira'},{id:'b',name:'Rowan'}]});
  const panels=pages.flatMap(p=>p.panels);
  assert.equal(panels.length, 5);
  five.forEach((line,i)=>assert.equal(panels[i].prompt, line));
  assert.deepEqual(panels[0].cast, ['a']);
  assert.deepEqual(panels[1].cast, ['a','b']);
  assert.deepEqual(panels[2].cast, ['b']);
  assert.deepEqual(panels[4].cast, ['a','b']);
});

test('an unselected library character never enters a panel prompt or reference list', ()=>{
  const mira={id:'mira',name:'Mira',age:32,description:'amber eyes',hair:'dark curls',body:'athletic',outfit:'jacket',tattoos:'constellation',refId:'ref-mira',portraitId:'port-mira'};
  const luna={id:'luna',name:'Luna',age:34,description:'UNSELECTEDTOKEN violet eyes',hair:'silver bob',body:'tall',outfit:'coat',tattoos:'UNSELECTEDMARK',refId:'ref-luna',portraitId:'port-luna'};
  const pages=buildEpisodePages({
    script:'Mira opens the door.\n\nThe kitchen is quiet.',
    cast:['mira'],
    characters:[mira,luna]
  });
  const panels=pages.flatMap(p=>p.panels);
  for(const panel of panels){
    const job=panelJob(panel, [mira,luna], 'Painted light');
    const blob=`${job.prompt}\n${job.referenceIds.join(',')}\n${job.portraitIds.join(',')}\n${job.characters.map(c=>c.id).join(',')}`;
    assert.doesNotMatch(blob, /Luna|UNSELECTEDTOKEN|UNSELECTEDMARK|ref-luna|port-luna/);
    assert.deepEqual(panel.cast, ['mira']);
  }
});

test('Jade’s door scene stays whole and ahead of a long look sheet', ()=>{
  const dump=('Look sheet turnaround on a plain white background, character lineup, multiple views, grid, nude reference. ').repeat(40);
  const jade={id:'jade',name:'Jade',age:29,fictional:true,refId:'ref-jade',description:`Green eyes, sharp cheekbones. ${dump}`,hair:`Long straight black hair past the shoulders. ${dump}`,body:`Tall athletic adult build. ${dump}`,outfit:'Nude. No clothing. Reference nude.',tattoos:`SNAKEONTHIGH on the left thigh, rose on the right shoulder blade. ${dump}`,personality:'THIS_PERSONALITY_SHOULD_NOT_APPEAR',backstory:'THIS_BACKSTORY_SHOULD_NOT_APPEAR',look:{always:dump,eyeColor:'green',hairColor:'long straight black',build:'tall athletic',outfit:'nude',tattoos:[{design:'SNAKEONTHIGH',placement:'left thigh'},{design:'rose',placement:'right shoulder blade'}]}};
  const mark={id:'mark',name:'Mark',age:36,refId:'ref-mark',description:`Brown eyes and a short beard. ${dump}`,hair:'Short brown hair',body:'Broad adult build',outfit:'Flannel shirt and jeans',tattoos:'ANCHORTATTOO on the left forearm'};
  const sam={id:'sam',name:'Sam',age:33,refId:'ref-sam',description:'Blue eyes.',hair:'Buzz cut',body:'Lean build',outfit:'Grey hoodie',tattoos:'SAMUNIQUE on the wrist'};
  const scene='Jade answers the door wearing just a t-shirt and pants. She realizes it\'s Mark, her ex husband.';
  const job=panelJob({cast:['jade','mark','sam'],prompt:scene,camera:'over-the-shoulder shot'}, [jade,mark,sam], 'Stylized 3D toon faces, expressive adult proportions, hyper-realistic skin textures, cinematic lighting, intricate tattoo detail, polished animated-feature rendering.', {limit:7500});
  const prompt=job.prompt;
  assert.ok(prompt.length<=7500);
  assert.match(prompt, /^A cinematic 3D animated film still of grown adults in their 30s with mature adult faces: defined cheekbones and jawlines, adult facial structure, natural adult proportions, detailed realistic skin/);
  assert.doesNotMatch(prompt, /\bcomic\b|lettering|speech bubble|word balloon/i);
  assert.ok(prompt.includes(scene));
  const sceneAt=prompt.indexOf(scene);
  assert.ok(sceneAt>0&&sceneAt<400);
  assert.ok(sceneAt<prompt.indexOf('Characters, fictional adults, age 18+'));
  assert.ok(sceneAt<prompt.indexOf('SNAKEONTHIGH'));
  assert.match(prompt, /Camera: over-the-shoulder shot/);
  assert.match(prompt, /t-shirt and pants/);
  assert.match(prompt, /SNAKEONTHIGH on the left thigh/);
  assert.match(prompt, /Long straight black hair past the shoulders|long straight black hair/i);
  assert.match(prompt, /green eyes/i);
  assert.match(prompt, /athletic/i);
  assert.match(prompt, /ANCHORTATTOO on the left forearm/);
  assert.match(prompt, /Do not depict nudity/);
  assert.doesNotMatch(prompt, /\bnude\b/i);
  assert.doesNotMatch(prompt, /white background/i);
  assert.doesNotMatch(prompt, /turnaround/i);
  assert.doesNotMatch(prompt, /lineup/i);
  assert.doesNotMatch(prompt, /\bon a\b/i);
  assert.doesNotMatch(prompt, /Flannel shirt/);
  assert.doesNotMatch(prompt, /\bSam\b/);
  assert.doesNotMatch(prompt, /SAMUNIQUE/);
  assert.doesNotMatch(prompt, /Grey hoodie/);
  assert.doesNotMatch(prompt, /THIS_PERSONALITY_SHOULD_NOT_APPEAR/);
  assert.doesNotMatch(prompt, /THIS_BACKSTORY_SHOULD_NOT_APPEAR/);
  const castLine=prompt.split('Characters, fictional adults, age 18+: ')[1].split('\n')[0];
  for(const part of castLine.split(' | '))assert.ok(part.length<=300, part);
  assert.deepEqual(job.referenceIds, ['ref-jade','ref-mark']);
  assert.equal(job.seed, characterSeed('jade|mark'));
  assert.equal(job.characters.map(c=>c.id).join('|'), 'jade|mark');
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
  assert.doesNotMatch(job.prompt, /speech bubble|word balloon|\bcomic\b|lettering/i);
  assert.doesNotMatch(job.prompt, /draw a speech|one line per bubble/i);
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
