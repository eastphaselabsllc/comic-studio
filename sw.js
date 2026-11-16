const CACHE='comic-studio-v1.14.0';
const FILES=['./','./index.html','./styles.css','./app.js','./core.js','./db.js','./provider.js','./batch.js','./bubbles.js','./manifest.json','./icon.svg','./icon-192.png','./icon-512.png','./bubbles/round-speech.svg','./bubbles/thought-cloud.svg','./bubbles/shout-burst.svg','./bubbles/whisper-dashed.svg','./bubbles/caption-box.svg'];
function shellURL(path){return new URL(path,self.registration.scope).href;}
function freshRequest(request){
  const cache='no-cache';
  if(request.mode==='navigate'){
    const credentials=request.credentials==='include'||request.credentials==='omit'||request.credentials==='same-origin'?request.credentials:'same-origin';
    return new Request(request.url,{cache,credentials,redirect:'follow'});
  }
  try{return new Request(request,{cache});}
  catch{return new Request(request.url,{cache,credentials:'same-origin'});}
}
self.addEventListener('install',e=>{e.waitUntil((async()=>{
  const cache=await caches.open(CACHE);
  await Promise.all(FILES.map(async path=>{
    const url=shellURL(path);
    const res=await fetch(new Request(url,{cache:'reload'}));
    if(!res.ok)throw Error('Could not cache '+path);
    await cache.put(url,res);
  }));
  await self.skipWaiting();
})());});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('comic-studio-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
async function networkFirst(request){
  const cache=await caches.open(CACHE);
  try{
    const res=await fetch(freshRequest(request));
    if(res&&res.ok&&res.status===200&&res.type!=='opaque'){
      const clean=new URL(request.url);
      clean.search='';
      try{await cache.put(clean.href,res.clone());}catch{/* A fresh response still wins when Cache Storage rejects the write. */}
    }
    return res;
  }catch(err){
    const hit=await cache.match(request)||await cache.match(request,{ignoreSearch:true});
    if(hit)return hit;
    if(request.mode==='navigate'){
      const home=await cache.match(shellURL('./'))||await cache.match(shellURL('./index.html'));
      if(home)return home;
    }
    throw err;
  }
}
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.origin!==self.location.origin)return;
  if(u.pathname.includes('/bubbles/')){
    e.respondWith(caches.open(CACHE).then(async cache=>{
      const hit=await cache.match(e.request);
      if(hit)return hit;
      const res=await fetch(e.request);
      if(res.ok)cache.put(e.request,res.clone()).catch(()=>{});
      return res;
    }));
    return;
  }
  const allowed=FILES.map(p=>new URL(p,self.registration.scope).pathname);
  if(e.request.mode!=='navigate'&&!allowed.includes(u.pathname))return;
  e.respondWith(networkFirst(e.request));
});
