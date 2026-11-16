import test from 'node:test';
import assert from 'node:assert/strict';
import {panelJob, panelPrompt, standaloneImageJob} from '../core.js';
import {IMAGE_NEGATIVE, negativePromptFor} from '../provider.js';

const jade={id:'jade',name:'Jade',age:32,fictional:true,description:'Green eyes, sharp cheekbones, usually in a green latex bodysuit.',hair:'Long straight black hair',body:'Tall athletic adult build',outfit:'Green latex bodysuit',tattoos:'A snake on the left thigh'};
const kody={id:'kody',name:'Kody',age:34,fictional:true,description:'Brown eyes and a short beard.',hair:'Short brown hair',body:'Broad adult build',outfit:'Black t-shirt and jeans',tattoos:'none'};

function promptFor(scene, characters=[jade,kody]){
  return panelPrompt({style:'Ink',camera:'Medium shot, eye level',scene,characters,limit:7500});
}

test('a nude scene drops the saved outfit and clothing hidden in the description', ()=>{
  const dressed=promptFor('Jade waits on the balcony with Kody.');
  assert.match(dressed, /Outfit: Green latex bodysuit/);
  assert.match(dressed, /Outfit: Black t-shirt and jeans/);
  assert.match(dressed, /Use each saved outfit/);
  const nude=promptFor('Jade is nude on the balcony.');
  assert.match(nude, /Scene: Jade is nude on the balcony/);
  assert.doesNotMatch(nude, /bodysuit|latex/i);
  assert.doesNotMatch(nude, /Jade[^|]*Outfit:/);
  assert.match(nude, /Outfit: Black t-shirt and jeans/);
  assert.doesNotMatch(nude, /Dress follows|Use each saved outfit|Do not depict nudity/);
  assert.match(nude, /Long straight black hair/);
  assert.match(nude, /Green eyes/);
  assert.match(nude, /Tall athletic adult build/);
  assert.match(nude, /A snake on the left thigh/);
  assert.match(nude, /sharp cheekbones/);
  for(const scene of ['Jade is naked.','Jade is undressed.','Jade is topless.','Jade has no clothes.','Jade strips on the balcony.']){
    const built=promptFor(scene, [jade]);
    assert.doesNotMatch(built, /bodysuit|latex|Outfit:/i, scene);
    assert.match(built, /Long straight black hair/, scene);
    assert.match(built, /snake on the left thigh/i, scene);
  }
});

test('only the character named in the nude sentence loses their outfit', ()=>{
  const mixed=promptFor('Jade is nude. Kody stands beside her.');
  assert.doesNotMatch(mixed, /bodysuit|latex/i);
  assert.doesNotMatch(mixed, /Jade[^|]*Outfit:/);
  assert.match(mixed, /Outfit: Black t-shirt and jeans/);
  assert.match(mixed, /Short brown hair/);
  assert.match(mixed, /A snake on the left thigh/);
  const everyone=promptFor('They stand together on the balcony, nude.');
  assert.doesNotMatch(everyone, /bodysuit|jeans|Outfit:|t-shirt/i);
  assert.match(everyone, /Long straight black hair/);
  assert.match(everyone, /Short brown hair/);
  const job=panelJob({cast:['jade','kody'],prompt:'Jade is nude. Kody stands beside her.',camera:'Medium shot, eye level'}, [jade,kody], 'Ink');
  assert.equal(job.suppressWardrobe, true);
  assert.equal(job.prompt, mixed);
  const clothed=panelJob({cast:['jade'],prompt:'Jade waits on the balcony.',camera:'Medium shot, eye level'}, [jade], 'Ink');
  assert.equal(clothed.suppressWardrobe, false);
  assert.match(negativePromptFor(job.characters,{undressed:true}), /bodysuit/);
  assert.match(negativePromptFor(job.characters,{undressed:true}), /latex suit/);
  assert.match(negativePromptFor(job.characters,{undressed:true}), /clothing/);
  assert.doesNotMatch(negativePromptFor(job.characters), /bodysuit|latex suit/);
  assert.doesNotMatch(IMAGE_NEGATIVE, /bodysuit/);
  assert.doesNotMatch(negativePromptFor(job.characters,{undressed:true,sheet:true}), /bodysuit/);
});

test('the Images page uses the same wardrobe rule as a panel', ()=>{
  const scene='Jade is nude on the balcony.';
  const panel=panelPrompt({style:'Ink',camera:'Medium shot, eye level',scene,characters:[jade],limit:7500});
  const image=standaloneImageJob({prompt:scene,style:'Ink',cast:['jade'],characters:[jade,kody],limit:7500});
  assert.equal(image.prompt, panel);
  assert.equal(image.suppressWardrobe, true);
  assert.doesNotMatch(image.prompt, /bodysuit|Kody|jeans/);
  assert.match(image.prompt, /sharp cheekbones/);
  const kept=standaloneImageJob({prompt:'Jade waits on the balcony.',style:'Ink',cast:['jade'],characters:[jade]});
  assert.match(kept.prompt, /Green latex bodysuit/);
  assert.equal(kept.suppressWardrobe, false);
});
