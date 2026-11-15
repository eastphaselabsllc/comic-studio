import test from 'node:test';
import assert from 'node:assert/strict';
import {STYLE, hasTattoos, identityLine, characterText, panelPrompt, portraitPrompt, panelJob, likenessLine, stripStyleTattoos} from '../core.js';
import {Provider, defaults, negativePromptFor, IMAGE_NEGATIVE, SHEET_NEGATIVE, veniceImageBody} from '../provider.js';

const LEGACY='Stylized 3D toon faces, expressive adult proportions, hyper-realistic skin textures, cinematic lighting, intricate tattoo detail, polished animated-feature rendering.';
const memory=new Map();
globalThis.localStorage={
  getItem:key=>memory.has(key)?memory.get(key):null,
  setItem:(key,value)=>memory.set(key,String(value)),
  removeItem:key=>memory.delete(key),
  clear:()=>memory.clear()
};

function clean(extra={}){return {id:'mira',name:'Mira',age:32,description:'amber eyes and a calm face',hair:'dark curls',body:'athletic adult build',outfit:'copper jacket',tattoos:'none',...extra};}
function inked(extra={}){return clean({tattoos:'constellation on the left forearm',...extra});}

test('the default style no longer asks for tattoos', ()=>{
  assert.doesNotMatch(STYLE, /tattoo/i);
  assert.match(STYLE, /cinematic lighting/);
  assert.match(STYLE, /polished animated-feature rendering/);
  assert.equal(stripStyleTattoos(LEGACY), 'Stylized 3D toon faces, expressive adult proportions, hyper-realistic skin textures, cinematic lighting, polished animated-feature rendering.');
});

test('negated tattoo fields are not tattoos', ()=>{
  for(const tattoos of ['', '   ', 'none', 'None.', 'NONE!', '(none)', 'no', 'No.', 'n/a', 'N/A', 'n.a.', 'na', 'nothing', 'nothing at all', 'no tattoos', 'No tattoos!', 'no tattoo', 'clean skin', 'clean-skin', 'no ink', 'NO INK', 'without tattoos', 'tattoo-free', 'unmarked', 'clean bare skin', 'does not have tattoos', "doesn't have any tattoos"]){
    assert.equal(hasTattoos({tattoos}), false, tattoos);
  }
  assert.equal(hasTattoos({tattoos:'none',look:{tattoos:['none',{design:'none',placement:'left forearm'}]}}), false);
  assert.equal(hasTattoos({tattoos:'',look:{tattoos:[]}}), false);
  assert.equal(hasTattoos({tattoos:'none',look:{tattoos:[{design:'rose',placement:'left shoulder'}]}}), true);
  assert.equal(hasTattoos(inked()), true);
});

test('tattoos none stays out of the positive prompt and is banned in the negative', ()=>{
  const person=clean({description:'amber eyes, no tattoos',hair:'dark curls, no tattoo',body:'athletic, without tattoos',tattoos:'N/A'});
  const saved=structuredClone(person);
  const prompt=panelPrompt({style:LEGACY,camera:'Medium shot, eye level',scene:'Mira waits by the glass. She has no tattoos.',characters:[person],likeness:true});
  assert.deepEqual(person, saved);
  assert.doesNotMatch(prompt, /tattoo/i);
  assert.match(prompt, /clean bare skin with no markings/);
  assert.match(prompt, /clean bare skin/);
  assert.match(prompt, /cinematic lighting/);
  assert.match(prompt, /polished animated-feature rendering/);
  assert.match(prompt, /amber eyes/);
  assert.match(prompt, /dark curls/);
  assert.doesNotMatch(prompt, /intricate tattoo detail/i);
  assert.match(prompt, /face and hair identical to their reference image/);
  assert.doesNotMatch(identityLine(person), /tattoo/i);
  assert.match(identityLine(person), /clean bare skin with no markings/);
  assert.doesNotMatch(characterText(person), /tattoo/i);
  const negative=negativePromptFor([person]);
  assert.match(negative, /tattoo, tattoos, body ink, body art, skin markings/);
  assert.doesNotMatch(negative, /missing tattoos/);
  assert.match(negative, /speech bubble/);
  assert.match(negative, /character lineup/);
  const portrait=portraitPrompt({style:LEGACY,characters:[person]});
  assert.doesNotMatch(portrait, /tattoo/i);
  assert.match(portrait, /clean bare skin with no markings/i);
  const sheet=panelPrompt({style:LEGACY,camera:'Character design turnaround, front side and back on a plain studio background',scene:'The same fictional adult in all three views. Consistent facial features, adult proportions, hair, and tattoo placement. Outfit or nudity follows the description. No text or labels.',characters:[person],sheet:true});
  assert.doesNotMatch(sheet, /tattoo/i);
  assert.match(sheet, /clean bare skin with no markings/i);
});

test('a real tattoo is still written into the prompt', ()=>{
  const person=inked();
  const prompt=panelPrompt({style:LEGACY,camera:'Medium shot, eye level',scene:'Mira waits by the glass.',characters:[person],likeness:true});
  assert.match(prompt, /Tattoos: constellation on the left forearm/);
  assert.match(prompt, /intricate tattoo detail/);
  assert.match(prompt, /face, hair, and tattoos identical/);
  assert.doesNotMatch(prompt, /clean bare skin/);
  assert.match(identityLine(person), /Tattoos: constellation on the left forearm/);
  assert.match(characterText(person), /Tattoos: constellation on the left forearm/);
  const negative=negativePromptFor([person]);
  assert.match(negative, /missing tattoos/);
  assert.doesNotMatch(negative, /body ink/);
  const portrait=portraitPrompt({style:'Ink',characters:[person]});
  assert.match(portrait, /tattoos clearly visible/);
  assert.match(portrait, /constellation on the left forearm/);
  const fromLook=clean({tattoos:'none',look:{tattoos:[{design:'rose',placement:'left shoulder'}]}});
  const looked=panelPrompt({style:'Ink',camera:'Medium shot',scene:'Mira waits.',characters:[fromLook]});
  assert.match(looked, /rose on the left shoulder/);
  assert.doesNotMatch(looked, /Tattoos:\s*none/i);
});

test('a mixed panel keeps one character inked and the other bare', ()=>{
  const mira=inked({id:'mira'});
  const rowan=clean({id:'rowan',name:'Rowan',age:35,description:'green eyes, no tattoos',hair:'short black hair',body:'broad shoulders',outfit:'charcoal coat',tattoos:'no tattoos'});
  const prompt=panelPrompt({style:LEGACY,camera:'Wide establishing shot',scene:'Mira and Rowan wait by the glass.',characters:[mira,rowan]});
  assert.match(prompt, /Tattoos: constellation on the left forearm/);
  assert.match(prompt, /clean bare skin with no markings/);
  assert.doesNotMatch(prompt, /Tattoos:\s*no tattoos/i);
  assert.doesNotMatch(prompt, /no tattoos/i);
  const castLine=prompt.split('Characters, fictional adults, age 18+: ')[1];
  const rowanPart=castLine.split(' | ').find(part=>part.startsWith('Rowan'));
  assert.ok(rowanPart);
  assert.doesNotMatch(rowanPart, /tattoo/i);
  assert.match(rowanPart, /clean bare skin with no markings/);
  assert.match(castLine, /Tattoos: constellation on the left forearm/);
  assert.match(prompt, /intricate tattoo detail/);
  const negative=negativePromptFor([mira,rowan]);
  assert.match(negative, /missing tattoos/);
  assert.equal(likenessLine([mira,rowan]).includes('tattoos'), true);
  assert.equal(likenessLine([rowan]).includes('tattoo'), false);
});

test('legacy intricate tattoo detail is removed only when nobody is inked', ()=>{
  const bare=panelJob({cast:['mira'],prompt:'Mira waits by the glass.',camera:'Medium shot, eye level'}, [clean()], LEGACY);
  assert.doesNotMatch(bare.prompt, /tattoo/i);
  assert.match(bare.prompt, /polished animated-feature rendering/);
  assert.match(bare.prompt, /cinematic lighting/);
  const marked=panelJob({cast:['mira'],prompt:'Mira waits by the glass.',camera:'Medium shot, eye level'}, [inked()], LEGACY);
  assert.match(marked.prompt, /intricate tattoo detail/);
  assert.match(marked.prompt, /constellation on the left forearm/);
});

test('venice generate receives a tattoo-aware negative prompt and does not call the network for real', async ()=>{
  assert.match(IMAGE_NEGATIVE, /tattoo, tattoos, body ink, body art, skin markings/);
  assert.match(IMAGE_NEGATIVE, /speech bubble/);
  assert.match(SHEET_NEGATIVE, /speech bubble/);
  assert.doesNotMatch(SHEET_NEGATIVE, /turnaround/);
  assert.doesNotMatch(SHEET_NEGATIVE, /character lineup/);
  const dropped=veniceImageBody({prompt:'p',negative_prompt:'tattoo, tattoos'}, [], {constraints:{supportsNegativePrompt:false}}, 3, 'experimental');
  assert.equal(dropped.negative_prompt, undefined);
  const kept=veniceImageBody({prompt:'p',negative_prompt:negativePromptFor([clean()])}, [], {constraints:{supportsNegativePrompt:true}}, 3, 'lustify-sdxl');
  assert.match(kept.negative_prompt, /body ink/);
  localStorage.setItem('cs_k','not-a-real-key');
  const seen=[];
  globalThis.fetch=async(url,opts)=>{seen.push({url:String(url),body:JSON.parse(opts.body)});throw new TypeError('Failed to fetch');};
  const provider=new Provider({...defaults,demo:false,imageModel:'lustify-sdxl'}, async()=>true);
  provider.models=[{id:'lustify-sdxl',type:'image',model_spec:{uncensored:true,constraints:{supportsNegativePrompt:true}}}];
  const barePrompt=panelPrompt({style:LEGACY,camera:'Medium shot',scene:'Mira waits.',characters:[clean()]});
  await assert.rejects(()=>provider.image(barePrompt, [], [clean({fictional:true})], {approved:true,seed:9}), /connection dropped/);
  assert.match(seen[0].url, /\/image\/generate$/);
  assert.equal(seen[0].body.model, 'lustify-sdxl');
  assert.match(seen[0].body.negative_prompt, /tattoo, tattoos, body ink, body art, skin markings/);
  assert.doesNotMatch(seen[0].body.negative_prompt, /missing tattoos/);
  assert.doesNotMatch(seen[0].body.prompt, /tattoo/i);
  seen.length=0;
  const inkPrompt=panelPrompt({style:'Ink',camera:'Medium shot',scene:'Mira waits.',characters:[inked()]});
  await assert.rejects(()=>provider.image(inkPrompt, [], [inked({fictional:true})], {approved:true,seed:9}), /connection dropped/);
  assert.match(seen[0].body.negative_prompt, /missing tattoos/);
  assert.match(seen[0].body.prompt, /constellation on the left forearm/);
  seen.length=0;
  const styled=new Provider({...defaults,demo:false,likenessMode:true,likenessModel:'krea-v2-large'}, async()=>true);
  styled.models=[{id:'krea-v2-large',type:'image',model_spec:{supportsStyleReferences:true,constraints:{maxStyleReferences:1,supportsStyleReferenceStrength:true,supportsNegativePrompt:true}}}];
  const likePrompt=panelPrompt({style:LEGACY,camera:'Wide establishing shot',scene:'Mira waits.',characters:[clean()],likeness:true});
  await assert.rejects(()=>styled.image(likePrompt, [], [clean({fictional:true})], {approved:true,preparedImages:['data:image/jpeg;base64,'+'A'.repeat(48)]}), /connection dropped/);
  assert.match(seen[0].url, /\/image\/generate$/);
  assert.match(seen[0].body.negative_prompt, /body ink/);
  assert.doesNotMatch(seen[0].body.prompt, /tattoo/i);
});
