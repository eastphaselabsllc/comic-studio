import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {validateLibrary, migrateLibrary, libraryNeedsMigration, buildEpisodePages, uid} from '../core.js';
import {DB_VERSION, upgradeDatabase} from '../db.js';

function library(pages, schemaVersion=1){
  return {
    schemaVersion,
    characters:[{id:'c1',age:32,fictional:true,refId:'ref1',name:'Mira Vale',description:'An expressive adult woman with amber eyes.',personality:'Warm',backstory:'A cartographer.',body:'Athletic adult build',hair:'Dark curls',outfit:'Copper jacket',tattoos:'A constellation'}],
    series:[{id:'s1',title:'After the Last Shuttle',synopsis:'Two grown explorers.',style:'Stylized adult comic art.',episodes:[{id:'e1',title:'Garden',script:'Mira and Rowan wait in the garden.',previousScript:'',cast:['c1'],pages}]}]
  };
}

test('indexedDB upgrade keeps existing stores and stories', ()=>{
  assert.equal(DB_VERSION, 2);
  assert.doesNotMatch(upgradeDatabase.toString(), /clear|deleteObjectStore/);
  const fresh=[];
  upgradeDatabase({
    objectStoreNames:{contains(){return false;}},
    createObjectStore(name, opts){fresh.push({name, opts});},
    deleteObjectStore(){throw Error('upgrade deleted a store');}
  });
  assert.deepEqual(fresh.map(x=>x.name), ['library','assets']);
  const again=[];
  upgradeDatabase({
    objectStoreNames:{contains(name){return name==='library'||name==='assets';}},
    createObjectStore(){throw Error('upgrade recreated an existing store');},
    deleteObjectStore(){throw Error('upgrade deleted a store');}
  });
  assert.deepEqual(again, []);
  const sw=fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(sw, /comic-studio-v1\.2\.0/);
  assert.doesNotMatch(sw, /comic-studio-v1\.1\.0/);
  for(const file of ['batch.js','bubbles.js','bubbles/round-speech.svg','bubbles/thought-cloud.svg','bubbles/shout-burst.svg','bubbles/whisper-dashed.svg','bubbles/caption-box.svg']){
    assert.match(sw, new RegExp(file.replace('/','\\/').replace('.','\\.')));
    assert.equal(fs.existsSync(new URL('../'+file, import.meta.url)), true);
  }
});

test('v1 stories migrate in place and a 45-panel comic round-trips with bubbles', ()=>{
  const pages=buildEpisodePages({script:'Mira waits.\n\nRowan smiles.\n\nThe shuttle is gone.',cast:['c1'],count:45});
  pages[0].panels[0].imageId='img1';
  const v1=library(pages.map(page=>({...page,panels:page.panels.map(panel=>{const copy={...panel};delete copy.bubbles;return copy;})})));
  assert.equal(libraryNeedsMigration(v1), true);
  const migrated=migrateLibrary(v1);
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.series[0].title, 'After the Last Shuttle');
  assert.equal(migrated.series[0].episodes[0].pages[0].panels[0].imageId, 'img1');
  assert.deepEqual(migrated.characters.map(c=>c.id), ['c1']);
  assert.ok(migrated.series[0].episodes[0].pages.every(p=>p.panels.every(panel=>Array.isArray(panel.bubbles))));
  assert.equal(JSON.stringify(v1.series[0].title), JSON.stringify(migrated.series[0].title));
  const bubble={id:uid(),preset:'round-speech',text:'Stay with me',x:0.12,y:0.1,w:0.5,h:0.24,fontSize:0.042,tailX:0.1,tailY:0.8,flip:false};
  migrated.series[0].episodes[0].pages[0].panels[0].bubbles=[bubble];
  const saved=validateLibrary(migrated);
  const panels=saved.series[0].episodes.flatMap(e=>e.pages.flatMap(p=>p.panels));
  assert.equal(saved.schemaVersion, 2);
  assert.equal(panels.length, 45);
  assert.equal(panels[0].imageId, 'img1');
  assert.equal(panels[0].bubbles[0].text, 'Stay with me');
  assert.equal(panels[0].bubbles[0].preset, 'round-speech');
  const legacy=validateLibrary(v1);
  assert.equal(legacy.schemaVersion, 2);
  assert.equal(legacy.series[0].episodes[0].pages.flatMap(p=>p.panels).length, 45);
  assert.deepEqual(legacy.series[0].episodes[0].pages[0].panels[0].bubbles, []);
  const bad={...structuredClone(saved), schemaVersion:2};
  bad.series[0].episodes[0].pages[0].panels[0].bubbles=[{...bubble,text:'a child'}];
  assert.throws(()=>validateLibrary(bad), /Adults only|18/);
  assert.equal(libraryNeedsMigration(saved), false);
});
