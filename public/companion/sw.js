const CACHE = 'media-companion-v14';
const ASSETS = ['/companion/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Never cache API calls
  if (e.request.url.includes('/companion/api/')) return;

  // Network-first for HTML and JS — always get latest app code
  if (e.request.mode === 'navigate' || e.request.url.endsWith('.html') || e.request.url.endsWith('.js') || e.request.url.endsWith('/')) {
    e.respondWith(
      fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      }).catch(() => caches.match(e.request).then(r => r || new Response('Offline', { status: 503 })))
    );
    return;
  }

  // Cache-first for other static assets (icons, manifest, CSS)
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});

// ========== PUSH NOTIFICATIONS ==========
self.addEventListener('push', e => {
  if (!e.data) return;
  const data = e.data.json();
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon || '/companion/icon-192.png',
      badge: data.badge || '/companion/icon-192.png',
      tag: data.tag || 'media-companion',
      renotify: true,
      vibrate: [200, 100, 200],
      timestamp: Date.now(),
      requireInteraction: false,
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
      if (cs.length) return cs[0].focus();
      return clients.openWindow('/companion');
    })
  );
});
