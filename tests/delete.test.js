import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {deleteCharacter, deleteSeries, deleteEpisode, validateLibrary, libraryNeedsMigration, migrateLibrary, assetIds} from '../core.js';

const app=fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const SAVED_STYLE='Saved series style. Pixar-like toon faces stay if the author wrote them.';

function character(id, name, extra={}){
  return {id, age:34, fictional:true, refId:null, portraitId:null, name, description:'An expressive adult with amber eyes.', personality:'Warm and direct.', backstory:'A cartographer who maps orbital gardens.', body:'Athletic adult build', hair:'Dark curls', outfit:'Copper jacket', tattoos:'A fine constellation on the forearm', ...extra};
}
function panel(id, cast, imageId, extra={}){
  return {id, cast:[...cast], imageId, bubblePosition:'top', captionPosition:'bottom', bubbles:extra.bubbles||[], prompt:'Mike waits in the garden.', camera:'Medium shot, eye level', dialogue:'', caption:'', ...extra};
}
function episode(id, title, cast, pages){
  return {id, title, script:'Mike and Amy wait in the garden.', previousScript:'', cast:[...cast], pages};
}
function series(id, title, episodes, style=SAVED_STYLE){
  return {id, title, synopsis:'Two grown explorers.', style, episodes};
}
function page(id, panels){return {id, layout:'two', panels};}
function bubble(){return {id:'bub1', preset:'round-speech', text:'Stay with me', x:0.12, y:0.1, w:0.5, h:0.22, fontSize:0.042, tailX:0.1, tailY:0.8, flip:false};}

function sample(){
  const mike=character('mike','Mike',{refId:'ref-mike', portraitId:'port-mike'});
  const amy=character('amy','Amy',{age:36, refId:'ref-amy', portraitId:'port-amy', seed:7, look:{hairColor:'Dark curls'}, description:'An adult woman with green eyes.'});
  const sam=character('sam','Sam',{age:40, description:'An adult man with a short beard.', tattoos:'No tattoos'});
  const lib={
    schemaVersion:2,
    characters:[mike, amy, sam],
    series:[
      series('s1','Garden', [
        episode('e1','Dawn',['amy','mike','sam'], [
          page('p1',[
            panel('pan-a',['mike'],'img-a',{bubbles:[bubble()]}),
            panel('pan-b',['sam','mike','amy'],'img-b')
          ])
        ]),
        episode('e2','Dusk',['mike'], [
          page('p2',[panel('pan-c',['amy','mike'],null)])
        ])
      ]),
      series('s2','Harbor', [
        episode('e3','Tide',['amy','mike'], [
          page('p3',[panel('pan-d',['mike'],'img-d')])
        ])
      ])
    ]
  };
  return lib;
}

test('deleteCharacter removes the person from every cast and orphans only their unused images', ()=>{
  const lib=sample();
  const before=structuredClone(lib);
  const result=deleteCharacter(lib,'mike');
  assert.deepEqual(lib, before);
  assert.notEqual(result.lib, lib);
  assert.deepEqual(result.lib.characters.map(c=>c.id), ['amy','sam']);
  assert.equal(result.lib.characters[0].seed, 7);
  assert.equal(result.lib.characters[0].look.hairColor, 'Dark curls');
  assert.equal(result.lib.series[0].style, SAVED_STYLE);
  const episodes=result.lib.series.flatMap(s=>s.episodes);
  assert.deepEqual(episodes.map(e=>e.cast), [['amy','sam'], [], ['amy']]);
  const panels=episodes.flatMap(e=>e.pages.flatMap(p=>p.panels));
  assert.deepEqual(panels.map(p=>p.id), ['pan-a','pan-b','pan-c','pan-d']);
  assert.deepEqual(panels.map(p=>p.cast), [[], ['sam','amy'], ['amy'], []]);
  assert.deepEqual(panels.map(p=>p.imageId), ['img-a','img-b',null,'img-d']);
  assert.equal(panels[0].bubbles[0].text, 'Stay with me');
  assert.equal(panels[0].prompt, 'Mike waits in the garden.');
  assert.deepEqual(result.orphanAssetIds, ['ref-mike','port-mike']);
  const ids=assetIds(result.lib);
  for(const id of ['img-a','img-b','img-d','ref-amy','port-amy'])assert.ok(ids.includes(id), id);
  for(const id of result.orphanAssetIds)assert.equal(ids.includes(id), false);
  assert.equal(libraryNeedsMigration(result.lib), false);
  const saved=validateLibrary(result.lib);
  assert.deepEqual(assetIds(saved).sort(), ids.sort());
  const migrated=migrateLibrary(saved);
  assert.deepEqual(migrated.characters.map(c=>c.id), ['amy','sam']);
  assert.equal(migrated.series[0].episodes[0].pages[0].panels[0].imageId, 'img-a');
});

test('a shared reference or portrait is kept, and one id used twice is listed once', ()=>{
  const lib=sample();
  lib.characters[1].refId='sheet';
  lib.characters[1].portraitId='sheet';
  lib.characters[2].refId='sheet';
  lib.characters[2].portraitId='port-sam';
  const dropAmy=deleteCharacter(lib,'amy');
  assert.deepEqual(dropAmy.orphanAssetIds, []);
  assert.equal(dropAmy.lib.characters.find(c=>c.id==='sam').refId, 'sheet');
  const dropSam=deleteCharacter(lib,'sam');
  assert.deepEqual(dropSam.orphanAssetIds, ['port-sam']);
  assert.ok(assetIds(dropSam.lib).includes('sheet'));
  const alone=sample();
  alone.characters[0].refId='both';
  alone.characters[0].portraitId='both';
  const once=deleteCharacter(alone,'mike');
  assert.deepEqual(once.orphanAssetIds, ['both']);
});

test('a character image that is still a panel is not orphaned', ()=>{
  const lib=sample();
  lib.characters[0].refId='img-a';
  lib.characters[0].portraitId='img-a';
  const result=deleteCharacter(lib,'mike');
  assert.deepEqual(result.orphanAssetIds, []);
  assert.equal(result.lib.series[0].episodes[0].pages[0].panels[0].imageId, 'img-a');
  assert.ok(assetIds(result.lib).includes('img-a'));
});

test('missing ids leave the library unchanged', ()=>{
  const lib=sample();
  for(const result of [deleteCharacter(lib,'nobody'), deleteSeries(lib,'nobody'), deleteEpisode(lib,'nobody')]){
    assert.deepEqual(result.orphanAssetIds, []);
    assert.deepEqual(result.lib, lib);
  }
});

test('deleteSeries removes only that series and panel images that belonged to it', ()=>{
  const lib=sample();
  lib.series[0].episodes[0].pages[0].panels[0].imageId='img-shared';
  lib.series[1].episodes[0].pages[0].panels[0].imageId='img-shared';
  lib.series[0].episodes[1].pages[0].panels[0].imageId='img-only';
  lib.series[0].episodes[0].pages[0].panels[1].imageId='ref-amy';
  const beforeCharacters=structuredClone(lib.characters);
  const result=deleteSeries(lib,'s1');
  assert.deepEqual(lib.characters, beforeCharacters);
  assert.deepEqual(result.lib.characters, beforeCharacters);
  assert.deepEqual(result.lib.series.map(s=>s.id), ['s2']);
  assert.equal(result.lib.series[0].episodes[0].pages[0].panels[0].imageId, 'img-shared');
  assert.deepEqual(result.orphanAssetIds, ['img-only']);
  assert.ok(assetIds(result.lib).includes('img-shared'));
  assert.ok(assetIds(result.lib).includes('ref-amy'));
  assert.equal(assetIds(result.lib).includes('img-only'), false);
  assert.equal(result.lib.series[0].style, SAVED_STYLE);
  const saved=validateLibrary(result.lib);
  assert.equal(libraryNeedsMigration(saved), false);
  assert.doesNotThrow(()=>migrateLibrary(saved));
  assert.deepEqual(assetIds(validateLibrary(saved)).sort(), assetIds(result.lib).sort());
});

test('deleteSeries never drops character assets when the series has no panel art', ()=>{
  const lib=sample();
  for(const episode of lib.series[0].episodes)for(const page of episode.pages)for(const panel of page.panels)panel.imageId=null;
  const result=deleteSeries(lib,'s1');
  assert.deepEqual(result.orphanAssetIds, []);
  assert.ok(assetIds(result.lib).includes('ref-mike'));
  assert.ok(assetIds(result.lib).includes('port-amy'));
});

test('deleteEpisode removes that chapter, keeps the series, and orphans only its images', ()=>{
  const lib=sample();
  lib.series[0].episodes[0].pages[0].panels[0].imageId='img-shared';
  lib.series[0].episodes[1].pages[0].panels[0].imageId='img-shared';
  lib.series[0].episodes[0].pages[0].panels[1].imageId='img-e1';
  const result=deleteEpisode(lib,'e1');
  assert.deepEqual(result.lib.characters.map(c=>c.name), ['Mike','Amy','Sam']);
  assert.deepEqual(result.lib.series.map(s=>s.id), ['s1','s2']);
  assert.deepEqual(result.lib.series[0].episodes.map(e=>e.id), ['e2']);
  assert.equal(result.lib.series[0].episodes[0].pages[0].panels[0].imageId, 'img-shared');
  assert.deepEqual(result.orphanAssetIds, ['img-e1']);
  assert.ok(assetIds(result.lib).includes('img-shared'));
  assert.equal(assetIds(result.lib).includes('img-e1'), false);
  const saved=validateLibrary(result.lib);
  assert.equal(libraryNeedsMigration(saved), false);
  assert.equal(migrateLibrary(saved).series[0].title, 'Garden');
  const last=deleteEpisode(result.lib,'e2');
  assert.deepEqual(last.lib.series[0].episodes, []);
  assert.deepEqual(last.orphanAssetIds, ['img-shared']);
  assert.equal(last.lib.series[0].id, 's1');
  validateLibrary(last.lib);
});

test('a library that still needs migration can lose a character without crashing', ()=>{
  const lib=sample();
  lib.schemaVersion=1;
  delete lib.series[0].episodes[0].pages[0].panels[0].bubbles;
  const result=deleteCharacter(lib,'mike');
  assert.equal(libraryNeedsMigration(result.lib), true);
  const migrated=migrateLibrary(result.lib);
  assert.ok(Array.isArray(migrated.series[0].episodes[0].pages[0].panels[0].bubbles));
  assert.deepEqual(migrated.series[0].episodes[0].pages[0].panels[0].cast, []);
  const saved=validateLibrary(migrated);
  assert.equal(saved.characters.some(c=>c.id==='mike'), false);
  assert.equal(saved.series[0].episodes[0].pages[0].panels[0].imageId, 'img-a');
  assert.equal(libraryNeedsMigration(saved), false);
});

test('delete controls use the danger style, confirm with ask, and clear the open selection', ()=>{
  assert.match(app, /button\('Delete character','delete-character','danger'/);
  assert.match(app, /button\('Delete series','delete-series','danger'/);
  assert.match(app, /button\('Delete episode','delete-episode','danger'/);
  assert.match(app, /delete-character','danger',`data-id="\$\{c\.id\}" data-mutates`/);
  assert.match(app, /delete-series','danger','data-mutates'/);
  assert.match(app, /delete-episode','danger','data-mutates'/);
  assert.match(app, /lib\.characters\.some\(x=>x\.id===c\.id\)/);
  assert.match(app, /existing\?`<div class="card danger-zone">/);
  assert.match(app, /Delete \$\{name\}\?/);
  assert.match(app, /This can't be undone\. Export your library first if you might want them back\./);
  assert.match(app, /This series contains \$\{n\} episode/);
  assert.match(app, /Delete \$\{title\}\?/);
  assert.match(app, /if\(sid===s\.id\)\{sid=null;eid=null;\}/);
  assert.match(app, /if\(eid===e\.id\)eid=null/);
  assert.match(app, /await forgetAssets\(result\.orphanAssetIds\)/);
});
