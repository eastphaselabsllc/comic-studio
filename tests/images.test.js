import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {STYLE, assertSafe, assetIds, panelJob, standaloneImageJob, validateStandalone} from '../core.js';
import {DB_VERSION, deleteAssets, deleteStandalone, exportLibrary, getAsset, getLibrary, importLibrary, listStandalone, putAsset, putStandalone} from '../db.js';
import {negativePromptFor} from '../provider.js';

const mira={id:'mira',name:'Mira Vale',age:32,fictional:true,description:'An expressive adult woman with amber eyes.',personality:'Warm',backstory:'A cartographer.',body:'Athletic adult build',hair:'Dark curls',outfit:'Copper jacket',tattoos:'A constellation on the forearm',refId:'ref-mira',portraitId:'port-mira'};
const rowan={id:'rowan',name:'Rowan Ash',age:35,fictional:true,description:'A broad-shouldered adult man with green eyes.',personality:'Patient',backstory:'A botanical engineer.',body:'Broad adult build',hair:'Short black hair',outfit:'Charcoal coat',tattoos:'none',refId:'ref-rowan',portraitId:null};

test('standalone prompts reuse the panel prompt, cast filter, and negative prompt', ()=>{
  const scene='Mira waits by the glass.';
  const job=standaloneImageJob({prompt:scene,style:STYLE,cast:['mira'],characters:[mira,rowan],likeness:false});
  const panel=panelJob({prompt:scene,camera:'Medium shot, eye level',cast:['mira']},[mira],STYLE,{likeness:false});
  assert.equal(job.prompt, panel.prompt);
  assert.equal(job.seed, panel.seed);
  assert.deepEqual(job.referenceIds, panel.referenceIds);
  assert.deepEqual(job.portraitIds, panel.portraitIds);
  assert.deepEqual(job.characters.map(c=>c.id), ['mira']);
  assert.match(job.prompt, /A cinematic 3D animated film still of grown adults in their 30s with mature adult faces: defined cheekbones and jawlines/);
  assert.match(job.prompt, /Camera: Medium shot, eye level/);
  assert.match(job.prompt, /Art style: /);
  assert.match(job.prompt, /Dark curls/);
  assert.doesNotMatch(job.prompt, /Short black hair/);
  assert.equal(negativePromptFor(job.characters), negativePromptFor(panel.characters));
  assert.match(negativePromptFor(job.characters), /missing tattoos/);
  assert.doesNotThrow(()=>assertSafe(job.prompt, job.characters));
});

test('a standalone image with nobody picked does not add saved looks', ()=>{
  const job=standaloneImageJob({prompt:'Rowan looks back from a moonlit balcony.',style:STYLE,cast:[],characters:[mira,rowan]});
  assert.equal(job.characters.length, 0);
  assert.deepEqual(job.referenceIds, []);
  assert.deepEqual(job.portraitIds, []);
  assert.match(job.prompt, /All depicted people are fictional adults, age 18\+/);
  assert.match(job.prompt, /grown adults in their 30s/);
  assert.doesNotMatch(job.prompt, /Dark curls|Short black hair/);
  const bare=standaloneImageJob({prompt:'A moonlit balcony, quiet and close.',style:'',cast:[],characters:[]});
  assert.doesNotMatch(bare.prompt, /Art style:/);
  assert.match(bare.prompt, /grown adults in their 30s with mature adult faces/);
});

test('likeness wording and named-cast filtering match panels', ()=>{
  const scene='Mira and Rowan wait by the glass.';
  const liked=standaloneImageJob({prompt:scene,style:STYLE,cast:['rowan','mira'],characters:[mira,rowan],likeness:true});
  const panel=panelJob({prompt:scene,camera:'Medium shot, eye level',cast:['rowan','mira']},[mira,rowan],STYLE,{likeness:true});
  assert.equal(liked.prompt, panel.prompt);
  assert.match(liked.prompt, /identical to their reference image/);
  assert.deepEqual(liked.characters.map(c=>c.id), panel.characters.map(c=>c.id));
  assert.equal(negativePromptFor(liked.characters), negativePromptFor(panel.characters));
  const named=standaloneImageJob({prompt:'Mira waits by the glass.',style:STYLE,cast:['mira','rowan'],characters:[mira,rowan]});
  const namedPanel=panelJob({prompt:'Mira waits by the glass.',camera:'Medium shot, eye level',cast:['mira','rowan']},[mira,rowan],STYLE);
  assert.equal(named.prompt, namedPanel.prompt);
  assert.deepEqual(named.characters.map(c=>c.id), ['mira']);
});

test('standalone records keep the same content blocks', ()=>{
  const blocked=standaloneImageJob({prompt:'a schoolgirl waits on the balcony',style:STYLE,cast:[],characters:[]});
  assert.throws(()=>assertSafe(blocked.prompt, blocked.characters), /Adults only/);
  assert.throws(()=>validateStandalone([{id:'bad-image',prompt:'a schoolgirl',style:'Ink',camera:'Medium shot, eye level',cast:[],imageId:'bad-blob',createdAt:1}]), /Adults only/);
  assert.throws(()=>validateStandalone([{id:'bad-image',prompt:'non-consensual',style:'Ink',camera:'Medium shot, eye level',cast:[],imageId:'bad-blob',createdAt:1}]), /not allowed/);
  const saved=validateStandalone([{id:'shot-1',prompt:'  A quiet balcony at night. ',style:STYLE,camera:'',cast:['mira','mira'],imageId:'img-shot',createdAt:5}]);
  assert.equal(saved[0].prompt, 'A quiet balcony at night.');
  assert.deepEqual(saved[0].cast, ['mira']);
  assert.equal(saved[0].style, STYLE);
});

test('the image page is wired to the panel generator and its own store', ()=>{
  const app=fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const html=fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /data-nav="images"/);
  assert.match(app, /nav==='images'/);
  assert.match(app, /standaloneImageJob\(/);
  assert.match(app, /putStandalone\(/);
  const start=app.indexOf('async function generateStandaloneImage');
  assert.notEqual(start, -1);
  let depth=0, end=-1;
  for(let i=app.indexOf('{', start); i<app.length; i++){
    if(app[i]==='{')depth++;
    else if(app[i]==='}'){depth--; if(depth===0){end=i+1; break;}}
  }
  const fn=app.slice(start, end);
  assert.match(fn, /provider\.image\(job\.prompt,job\.referenceIds,job\.characters/);
  assert.match(fn, /portraitIds:settings\.likenessMode\?job\.portraitIds:\[\]/);
  assert.match(fn, /if\(settings\.likenessMode&&!job\.characters\.length\)opts\.forceGenerate=true/);
  assert.match(fn, /if\(job\.suppressWardrobe&&!settings\.likenessMode\)opts\.negativePrompt=negativePromptFor\(job\.characters,\{undressed:true\}\)/);
  assert.match(fn, /assertSafe\(/);
  assert.doesNotMatch(fn, /width:|height:|lib\.series|saveLibrary|buildEpisodePages/);
});

function pngBlob(){
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');
  return new Blob([bytes],{type:'image/png'});
}

function installImageStubs(){
  globalThis.FileReader=class{
    readAsDataURL(blob){
      blob.arrayBuffer().then(buf=>{
        this.result=`data:${blob.type||'application/octet-stream'};base64,${Buffer.from(buf).toString('base64')}`;
        this.onload?.();
      }).catch(error=>{this.error=error; this.onerror?.(error);});
    }
  };
  globalThis.createImageBitmap=async()=>({width:4,height:4,close(){}});
  globalThis.document={createElement(){return {width:1,height:1,getContext(){return {fillStyle:'',fillRect(){},drawImage(){}};},toBlob(cb,type){cb(new Blob([Uint8Array.from([1,2,3,4])],{type:type||'image/png'}));}};}};
}

function createIndexedDB(){
  const databases=new Map();
  function makeRequest(){return {result:undefined,error:null,onsuccess:null,onerror:null,onupgradeneeded:null,onblocked:null};}
  function clone(value){try{return structuredClone(value);}catch{return value;}}
  class Transaction{
    constructor(db){
      this.db=db; this.oncomplete=null; this.onerror=null; this.onabort=null; this.error=null;
      this.pending=0; this.finished=false; this.opened=false;
      queueMicrotask(()=>{this.opened=true; this.maybeDone();});
    }
    objectStore(name){
      const data=this.db.stores.get(name);
      if(!data)throw Error('Missing store '+name);
      return new Store(this, data);
    }
    start(){this.pending++;}
    end(){this.pending--; queueMicrotask(()=>this.maybeDone());}
    maybeDone(){if(!this.opened||this.finished||this.pending>0)return; this.finished=true; queueMicrotask(()=>this.oncomplete?.());}
    abort(error){if(this.finished)return; this.finished=true; this.error=error; queueMicrotask(()=>{this.onabort?.(); this.onerror?.();});}
  }
  class Store{
    constructor(tx, data){this.tx=tx; this.data=data;}
    request(fn){
      const req=makeRequest();
      this.tx.start();
      queueMicrotask(()=>{
        if(this.tx.finished)return;
        try{req.result=fn(); req.onsuccess?.({target:req}); this.tx.end();}
        catch(error){req.error=error; req.onerror?.({target:req}); this.tx.abort(error);}
      });
      return req;
    }
    get(key){return this.request(()=>this.data.records.has(key)?clone(this.data.records.get(key)):undefined);}
    getAll(){return this.request(()=>[...this.data.records.values()].map(clone));}
    getAllKeys(){return this.request(()=>[...this.data.records.keys()]);}
    put(value, key){return this.request(()=>{const stored=clone(value); const id=key===undefined?stored[this.data.keyPath]:key; this.data.records.set(id, stored); return id;});}
    delete(key){return this.request(()=>{this.data.records.delete(key);});}
    clear(){return this.request(()=>{this.data.records.clear();});}
  }
  function createDatabase(name, version){
    const stores=new Map();
    return {
      name, version, stores,
      objectStoreNames:{contains(store){return stores.has(store);}},
      createObjectStore(store, opts){if(stores.has(store))throw Error('Store already exists: '+store); stores.set(store,{keyPath:opts?.keyPath,records:new Map()});},
      deleteObjectStore(){throw Error('upgrade deleted a store');},
      transaction(store){return new Transaction(this);}
    };
  }
  return {
    databases,
    seed(name, version, fill){const db=createDatabase(name, version); fill(db); databases.set(name, db); return db;},
    open(name, version){
      const req=makeRequest();
      queueMicrotask(()=>{
        try{
          let database=databases.get(name);
          if(!database){database=createDatabase(name, version); databases.set(name, database); req.result=database; req.onupgradeneeded?.({target:req, oldVersion:0, newVersion:version}); req.onsuccess?.({target:req}); return;}
          if(database.version<version){const old=database.version; database.version=version; req.result=database; req.onupgradeneeded?.({target:req, oldVersion:old, newVersion:version}); req.onsuccess?.({target:req}); return;}
          req.result=database; req.onsuccess?.({target:req});
        }catch(error){req.error=error; req.onerror?.({target:req});}
      });
      return req;
    }
  };
}

function storyLibrary(){
  return {
    schemaVersion:2,
    characters:[{id:'c1',age:32,fictional:true,refId:null,portraitId:null,name:'Mira Vale',description:'An expressive adult woman with amber eyes.',personality:'Warm',backstory:'A cartographer.',body:'Athletic adult build',hair:'Dark curls',outfit:'Copper jacket',tattoos:'A constellation'}],
    series:[{id:'s1',title:'After the Last Shuttle',synopsis:'Two grown explorers.',style:'Stylized adult comic art.',episodes:[{id:'e1',title:'Garden',script:'Mira waits in the garden.',previousScript:'',cast:['c1'],pages:[{id:'p1',layout:'single',panels:[{id:'panel1',cast:['c1'],imageId:'img1',bubbles:[],prompt:'Mira waits in the garden.',camera:'Wide establishing shot',dialogue:'',caption:'',bubblePosition:'top',captionPosition:'bottom'}]}]}]}]
  };
}

function miniLibrary(title){
  return {schemaVersion:2,characters:[],series:[{id:'s9',title,synopsis:'Two grown explorers.',style:'Ink lines.',episodes:[]}]};
}

test('opening v3 keeps a v2 library and stores standalone images apart from it', async ()=>{
  installImageStubs();
  const idb=createIndexedDB();
  globalThis.indexedDB={open:(name,version)=>idb.open(name,version)};
  const original=storyLibrary();
  idb.seed('comic-studio', 2, db=>{
    db.createObjectStore('library');
    db.createObjectStore('assets',{keyPath:'id'});
    db.stores.get('library').records.set('root', original);
    db.stores.get('assets').records.set('img1', {id:'img1', blob:pngBlob()});
  });
  const seeded=idb.databases.get('comic-studio');
  seeded.deleteObjectStore=()=>{throw Error('upgrade deleted a store');};
  assert.equal(DB_VERSION, 3);
  const loaded=await getLibrary();
  assert.equal(idb.databases.get('comic-studio').version, 3);
  assert.deepEqual([...idb.databases.get('comic-studio').stores.keys()].sort(), ['assets','library','standalone']);
  assert.equal(loaded.series[0].title, 'After the Last Shuttle');
  assert.equal(loaded.series[0].episodes[0].pages[0].panels[0].imageId, 'img1');
  assert.equal(loaded.series[0].episodes[0].pages[0].panels[0].prompt, 'Mira waits in the garden.');
  assert.equal(loaded.characters[0].name, 'Mira Vale');
  assert.equal((await getAsset('img1')).id, 'img1');
  assert.deepEqual(await listStandalone(), []);
  const keptRecord=idb.databases.get('comic-studio').stores.get('library').records.get('root');
  assert.equal(keptRecord.series[0].title, 'After the Last Shuttle');
  assert.equal(keptRecord.characters[0].id, 'c1');

  const olderId=await putAsset(pngBlob());
  const newerId=await putAsset(pngBlob());
  await putStandalone({id:'shot-old',prompt:'A quiet balcony at night for two fictional adults.',style:STYLE,camera:'Medium shot, eye level',cast:['c1'],imageId:olderId,createdAt:10});
  await putStandalone({id:'shot-new',prompt:'Amber light across a garden bench.',style:STYLE,camera:'Medium shot, eye level',cast:[],imageId:newerId,createdAt:20});
  let shots=await listStandalone();
  assert.deepEqual(shots.map(shot=>shot.id), ['shot-new','shot-old']);
  const after=await getLibrary();
  assert.equal(after.series.length, 1);
  assert.equal(after.series[0].episodes.length, 1);
  assert.equal(after.series[0].episodes[0].pages[0].panels[0].imageId, 'img1');
  assert.equal(JSON.stringify(after).includes('balcony'), false);
  assert.deepEqual(assetIds(after), ['img1']);
  assert.equal(assetIds(after).includes(olderId), false);
  await assert.rejects(()=>putStandalone({id:'shot-bad',prompt:'a schoolgirl on the balcony',style:STYLE,camera:'Medium shot, eye level',cast:[],imageId:olderId,createdAt:30}), /Adults only/);
  assert.equal((await listStandalone()).length, 2);

  await deleteStandalone('shot-new');
  shots=await listStandalone();
  assert.deepEqual(shots.map(shot=>shot.id), ['shot-old']);
  assert.equal((await getAsset(newerId)).id, newerId);
  const libraryAfterDelete=await getLibrary();
  assert.equal(assetIds(libraryAfterDelete).includes(newerId), false);
  assert.equal(shots.some(shot=>shot.imageId===newerId), false);
  await deleteAssets([newerId]);
  assert.equal(await getAsset(newerId), undefined);
  assert.equal((await getAsset(olderId)).id, olderId);
  assert.equal((await getAsset('img1')).id, 'img1');
  assert.equal(libraryAfterDelete.series[0].title, 'After the Last Shuttle');

  const backup=await exportLibrary(await getLibrary());
  assert.equal(backup.format, 'comic-studio');
  assert.equal(backup.version, 1);
  assert.deepEqual(backup.assets.map(asset=>asset.id), ['img1']);
  assert.deepEqual(backup.standaloneAssets.map(asset=>asset.id), [olderId]);
  assert.equal(backup.standalone.length, 1);
  assert.equal(backup.standalone[0].prompt, 'A quiet balcony at night for two fictional adults.');
  assert.equal(JSON.stringify(backup.library).includes(olderId), false);
  assert.equal(JSON.stringify(backup.library).includes('balcony'), false);

  const imported=await importLibrary({format:'comic-studio',version:1,library:miniLibrary('Imported Garden'),assets:[]});
  assert.equal(imported.series[0].title, 'Imported Garden');
  assert.equal((await getLibrary()).series[0].title, 'Imported Garden');
  assert.equal((await listStandalone())[0].id, 'shot-old');
  assert.equal((await getAsset(olderId)).id, olderId);
  assert.equal(await getAsset('img1'), undefined);

  const beforeBad=await getLibrary();
  await assert.rejects(()=>importLibrary({format:'comic-studio',version:1,library:miniLibrary('Should Not Land'),assets:[],standalone:[{id:'bad-image',prompt:'a schoolgirl',style:'Ink',camera:'Medium shot, eye level',cast:[],imageId:'bad-blob',createdAt:1}],standaloneAssets:[]}), /Adults only/);
  assert.equal((await getLibrary()).series[0].title, beforeBad.series[0].title);
  assert.equal((await listStandalone())[0].prompt, 'A quiet balcony at night for two fictional adults.');

  const restored=await importLibrary(backup);
  assert.equal(restored.series[0].title, 'After the Last Shuttle');
  assert.equal(restored.series[0].episodes[0].pages[0].panels[0].imageId, 'img1');
  assert.equal((await getAsset('img1')).id, 'img1');
  assert.equal((await listStandalone())[0].imageId, olderId);
  assert.equal((await getAsset(olderId)).blob instanceof Blob, true);
  assert.equal(JSON.stringify(await getLibrary()).includes('balcony'), false);

  await importLibrary({format:'comic-studio',version:1,library:miniLibrary('Cleared Gallery'),assets:[],standalone:[],standaloneAssets:[]});
  assert.equal((await getLibrary()).series[0].title, 'Cleared Gallery');
  assert.deepEqual(await listStandalone(), []);
  assert.equal(await getAsset(olderId), undefined);
});
