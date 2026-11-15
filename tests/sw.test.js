import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {VERSION} from '../core.js';

const swSource=fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const SCOPE='https://pages.example/repo/';
const CACHE=`comic-studio-v${VERSION}`;
const shell=path=>new URL(path, SCOPE).href;

function createEnv({trapDefault=false, files=new Map(), offline=false}={}){
  const stores=new Map();
  const fetches=[];
  const matches=[];
  function cacheApi(bucket){
    return {
      async put(req, res){
        const href=new URL(typeof req==='string'?req:req.url).href;
        bucket.set(href, res.clone());
      },
      async match(req, opts={}){
        const url=new URL(typeof req==='string'?req:req.url);
        matches.push({url:url.href, ignoreSearch:!!opts.ignoreSearch});
        if(bucket.has(url.href))return bucket.get(url.href).clone();
        if(opts.ignoreSearch){
          const path=url.origin+url.pathname;
          for(const [key, value] of bucket){
            const cached=new URL(key);
            if(cached.origin+cached.pathname===path)return value.clone();
          }
        }
        return undefined;
      },
      async addAll(){throw new Error('addAll should not be used');}
    };
  }
  const caches={
    async open(name){
      if(!stores.has(name))stores.set(name, new Map());
      return cacheApi(stores.get(name));
    },
    async keys(){return [...stores.keys()];},
    async delete(name){const had=stores.has(name);stores.delete(name);return had;}
  };
  const listeners={};
  const self={
    location:{origin:'https://pages.example'},
    registration:{scope:SCOPE},
    skipped:false,
    claimed:false,
    skipWaiting(){self.skipped=true;return Promise.resolve();},
    clients:{claim(){self.claimed=true;return Promise.resolve();}},
    addEventListener(type, fn){(listeners[type]||=[]).push(fn);}
  };
  async function fetchImpl(input, init){
    const request=new Request(input, init);
    fetches.push({url:request.url, cache:request.cache, method:request.method});
    if(trapDefault&&request.cache==='default')return new Response('STALE-HTTP-CACHE',{status:200});
    if(offline)throw new TypeError('Failed to fetch');
    const spec=files.get(request.url);
    if(spec?.throw)throw new TypeError('Failed to fetch');
    return new Response(spec?.body??`FRESH ${request.url}`,{status:spec?.status??200,headers:{'content-type':'text/plain'}});
  }
  const context=vm.createContext({self,caches,fetch:fetchImpl,Request,Response,URL,Promise,Error,TypeError,console});
  vm.runInContext(swSource, context, {filename:'sw.js'});
  function makeEvent(request){
    const tasks=[];
    return {
      request,
      responded:false,
      waitUntil(p){tasks.push(Promise.resolve(p));},
      respondWith(p){this.responded=true;this.responsePromise=p;tasks.push(Promise.resolve(p));},
      async finish(){for(const task of tasks)await task;}
    };
  }
  async function dispatch(type, request){
    const event=makeEvent(request);
    for(const fn of listeners[type]||[])fn(event);
    await event.finish();
    return event;
  }
  return {stores,fetches,matches,caches,self,dispatch};
}

function navigate(url){
  const request=new Request(url);
  Object.defineProperty(request, 'mode', {value:'navigate'});
  return request;
}

function filesInWorker(){
  const line=swSource.match(/const FILES=\[(.*)\];/)[1];
  return [...line.matchAll(/'([^']*)'/g)].map(match=>match[1]);
}

test('install stores fresh files with cache reload and skipWaiting', async ()=>{
  const env=createEnv({trapDefault:true});
  await env.dispatch('install');
  assert.equal(env.self.skipped, true);
  const files=filesInWorker();
  assert.equal(files.length, 18);
  assert.equal(env.fetches.length, files.length);
  for(const hit of env.fetches){
    assert.equal(hit.cache, 'reload');
    assert.equal(hit.method, 'GET');
  }
  const fetched=new Set(env.fetches.map(hit=>hit.url));
  const bucket=env.stores.get(CACHE);
  assert.ok(bucket);
  for(const file of files){
    const url=shell(file);
    assert.equal(fetched.has(url), true, file);
    const body=await bucket.get(url).clone().text();
    assert.match(body, /^FRESH /);
    assert.doesNotMatch(body, /STALE/);
  }
});

test('a failed shell file aborts install before skipWaiting', async ()=>{
  const env=createEnv({files:new Map([[shell('./icon.svg'),{status:404,body:'missing'}]])});
  await assert.rejects(()=>env.dispatch('install'), /Could not cache/);
  assert.equal(env.self.skipped, false);
  assert.equal(env.self.claimed, false);
});

test('app shell is network-first so a version query reaches the network', async ()=>{
  const env=createEnv({trapDefault:true});
  const cache=await env.caches.open(CACHE);
  await cache.put(shell('./app.js'), new Response('OLD-APP'));
  env.matches.length=0;
  const event=await env.dispatch('fetch', new Request(`${shell('./app.js')}?v=123`));
  assert.equal(event.responded, true);
  assert.equal(await (await event.responsePromise).text(), `FRESH ${shell('./app.js')}?v=123`);
  assert.equal(env.fetches.length, 1);
  assert.equal(env.fetches[0].cache, 'no-cache');
  assert.match(env.fetches[0].url, /\/app\.js\?v=123$/);
  assert.equal(env.matches.some(match=>match.ignoreSearch), false);
  assert.equal(await (await cache.match(shell('./app.js'))).text(), `FRESH ${shell('./app.js')}?v=123`);
});

test('offline shell falls back to the cached file after the network fails', async ()=>{
  const env=createEnv({offline:true});
  const cache=await env.caches.open(CACHE);
  await cache.put(shell('./app.js'), new Response('CACHED-APP'));
  const event=await env.dispatch('fetch', new Request(`${shell('./app.js')}?v=9`));
  assert.equal(await (await event.responsePromise).text(), 'CACHED-APP');
  assert.equal(env.fetches.length, 1);
  assert.equal(env.fetches[0].cache, 'no-cache');
  assert.equal(env.matches.some(match=>match.ignoreSearch), true);
});

test('a server error is returned and does not replace the cached shell', async ()=>{
  const env=createEnv({files:new Map([[shell('./core.js'),{status:500,body:'boom'}]])});
  const cache=await env.caches.open(CACHE);
  await cache.put(shell('./core.js'), new Response('GOOD'));
  const event=await env.dispatch('fetch', new Request(shell('./core.js')));
  assert.equal(await (await event.responsePromise).text(), 'boom');
  assert.equal(await (await cache.match(shell('./core.js'))).text(), 'GOOD');
});

test('navigations are network-first and fall back to the cached shell offline', async ()=>{
  const online=createEnv({trapDefault:true});
  const cache=await online.caches.open(CACHE);
  await cache.put(shell('./'), new Response('OLD-HOME'));
  const fresh=await online.dispatch('fetch', navigate(SCOPE));
  assert.equal(await (await fresh.responsePromise).text(), `FRESH ${SCOPE}`);
  assert.equal(online.fetches[0].cache, 'no-cache');
  assert.equal(await (await cache.match(SCOPE)).text(), `FRESH ${SCOPE}`);

  const offline=createEnv({offline:true});
  const saved=await offline.caches.open(CACHE);
  await saved.put(shell('./'), new Response('HOME'));
  const event=await offline.dispatch('fetch', navigate(`${SCOPE}missing-page`));
  assert.equal(event.responded, true);
  assert.equal(await (await event.responsePromise).text(), 'HOME');
  assert.equal(offline.fetches[0].url, `${SCOPE}missing-page`);
  assert.equal(offline.fetches[0].cache, 'no-cache');
});

test('bubble art stays cache-first and a miss still uses the original request', async ()=>{
  const hit=createEnv();
  const url=shell('./bubbles/round-speech.svg');
  const cache=await hit.caches.open(CACHE);
  await cache.put(url, new Response('CACHED-BUBBLE'));
  const cached=await hit.dispatch('fetch', new Request(url));
  assert.equal(await (await cached.responsePromise).text(), 'CACHED-BUBBLE');
  assert.equal(hit.fetches.length, 0);

  const miss=createEnv({trapDefault:true});
  const missing=shell('./bubbles/caption-box.svg');
  const fetched=await miss.dispatch('fetch', new Request(missing));
  assert.equal(await (await fetched.responsePromise).text(), 'STALE-HTTP-CACHE');
  assert.equal(miss.fetches[0].cache, 'default');
  const stored=await miss.caches.open(CACHE);
  assert.equal(await (await stored.match(missing)).text(), 'STALE-HTTP-CACHE');
});

test('cross-origin, non-GET, and unknown paths are not intercepted', async ()=>{
  const env=createEnv();
  for(const request of [
    new Request('https://api.venice.ai/api/v1/image/generate'),
    new Request(shell('./app.js'),{method:'POST'}),
    new Request(shell('./private/library.json'))
  ]){
    const event=await env.dispatch('fetch', request);
    assert.equal(event.responded, false);
  }
  assert.equal(env.fetches.length, 0);
});

test('activate deletes older comic-studio caches, keeps the current shell, and claims clients', async ()=>{
  const env=createEnv();
  env.stores.set(`${CACHE.replace(/2$/, '1')}`, new Map());
  env.stores.set('comic-studio-v1.10.0', new Map());
  env.stores.set(CACHE, new Map([[shell('./'), new Response('current')]]));
  env.stores.set('user-photos', new Map());
  env.stores.set('comic-studio', new Map());
  await env.dispatch('activate');
  assert.equal(env.self.claimed, true);
  assert.equal(env.self.skipped, false);
  assert.deepEqual([...env.stores.keys()].sort(), [CACHE, 'comic-studio', 'user-photos'].sort());
  assert.equal(await env.stores.get(CACHE).get(shell('./')).text(), 'current');
  assert.doesNotMatch(swSource, /indexedDB|localStorage|deleteDatabase/);
});
