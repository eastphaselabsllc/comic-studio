const CACHE='comic-studio-v1.1.0';
const FILES=['./','./index.html','./styles.css','./app.js','./core.js','./db.js','./provider.js','./manifest.json','./icon.svg','./icon-192.png','./icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('comic-studio-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==self.location.origin)return;const allowed=FILES.map(p=>new URL(p,self.registration.scope).pathname);if(!allowed.includes(u.pathname))return;e.respondWith(caches.match(e.request,{ignoreSearch:true}).then(c=>c||fetch(e.request)));});
