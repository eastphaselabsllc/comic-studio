import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PROMPT_TIPS, PROMPT_TOGETHER, buildScenePrompt, fillPromptTip} from '../core.js';

const jade={id:'jade',name:'Jade',savedOutfit:'A green jacket',action:'stands with one hand on the rail'};
const kody={id:'kody',name:'Kody',savedOutfit:'A dark shirt and trousers',action:'looks toward the window'};

test('two people are placed together and clothing is named per person', ()=>{
  const text=buildScenePrompt({
    people:[{...jade,clothing:'nude'},{...kody,clothing:'custom',outfit:'a dark shirt and trousers'}],
    together:'beside',
    setting:'a quiet balcony',
    camera:'Medium shot, eye level',
    lighting:'Moonlight'
  });
  assert.match(text, /Jade and Kody stand close beside each other in a quiet balcony\./);
  assert.match(text, /Jade stands with one hand on the rail\./);
  assert.match(text, /Kody looks toward the window\./);
  assert.equal(text.split(/(?<=\.)\s+/).find(s=>s.startsWith('Jade is nude')), 'Jade is nude.');
  assert.match(text, /Kody wears a dark shirt and trousers\./);
  assert.match(text, /Medium shot, eye level\./);
  assert.match(text, /Moonlight\./);
  assert.doesNotMatch(text, /green jacket/i);
});

test('a saved outfit stays out of the sentence until someone else is nude', ()=>{
  const alone=buildScenePrompt({people:[{...jade,clothing:'saved'}],setting:'a small room',camera:'Close-up, three-quarter view',lighting:'Soft daylight'});
  assert.match(alone, /Jade stands with one hand on the rail in a small room\./);
  assert.doesNotMatch(alone, /jacket|nude|wears/i);
  const paired=buildScenePrompt({people:[{...jade,clothing:'nude'},{...kody,clothing:'saved'}],setting:'a small room',together:'sitting'});
  assert.match(paired, /sit close together/);
  assert.match(paired, /Kody wears A dark shirt and trousers\./);
  assert.equal(PROMPT_TOGETHER.some(item=>item.id==='sitting'), true);
});

test('the builder keeps the same content blocks and the tips stay plain', ()=>{
  assert.throws(()=>buildScenePrompt({people:[{name:'Jade',action:'a schoolgirl stands by the window'}]}), /Adults only|not allowed/);
  assert.throws(()=>buildScenePrompt({people:[]}), /at least one character/);
  assert.throws(()=>buildScenePrompt({people:[{name:'Jade',clothing:'custom',outfit:''}]}), /outfit text/i);
  for(const tip of PROMPT_TIPS){
    assert.match(tip.template, /\{name\}|\{cast\}/);
    assert.doesNotMatch(`${tip.title} ${tip.template}`, /nude|naked|sex|lingerie|explicit/i);
  }
  assert.deepEqual(PROMPT_TIPS.map(tip=>tip.id), ['one','two','close','wide']);
  const filled=fillPromptTip('two',{names:['Jade','Kody'],setting:'a garden',camera:'Wide establishing shot',lighting:'Soft daylight'});
  assert.match(filled, /Jade and Kody stand close beside each other in a garden/);
  assert.doesNotMatch(filled, /\{name|\{setting|\{camera|\{lighting/);
  assert.throws(()=>fillPromptTip('close',{names:['a child']}), /Adults only|not allowed/);
});

test('Images and panel scene text share the builder', ()=>{
  const app=fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(app, /buildScenePrompt\(/);
  assert.match(app, /data-prompt-builder/);
  assert.match(app, /Tips that work/);
  assert.match(app, /'apply-image-builder':\(\)=>applyImageBuilder\(\)/);
  assert.match(app, /'build-panel-prompt':b=>openPanelBuilder/);
  assert.match(app, /id==='promptBuilderForm'/);
});
