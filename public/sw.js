// קוראים בכיף: offline support. The cache name changes automatically with every build.
const CACHE='kore-im-bekef-1.2.0-5df75060';
const SHELL=["./", "index.html", "manifest.webmanifest", "privacy.html", "fonts/noto-sans-hebrew.woff2", "fonts/secular-one.woff2", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE&&k!=='kore-tts-audio').map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
  const req=e.request;if(req.method!=='GET'||new URL(req.url).origin!==location.origin)return;
  if(req.mode==='navigate'){ // pages: network first, so updates arrive; each page cached under its own URL for offline use
    e.respondWith(fetch(req).then(r=>{if(r.ok){const c=r.clone();caches.open(CACHE).then(x=>x.put(req,c));}return r;}).catch(()=>caches.match(req).then(r=>r||caches.match('index.html'))));return;}
  const u=new URL(req.url);
  if(u.pathname==='/api/tts'){ // versioned speech clips: cache-first in a cache that survives app updates
    e.respondWith(caches.open('kore-tts-audio').then(c=>c.match(req).then(hit=>hit||fetch(req).then(r=>{if(r.ok)c.put(req,r.clone());return r;}))));return;}
  if(u.pathname.startsWith('/api/'))return; // health/approved/admin: always network
  e.respondWith(caches.match(req).then(r=>r||fetch(req)));
});
