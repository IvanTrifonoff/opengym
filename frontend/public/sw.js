/* openGym service worker — runtime caching (works with Vite's hashed asset names).
   Media (img/gif) cache-first; everything else network-first with offline fallback.
   Also maintains the app icon badge (Badging API) while the app is backgrounded:
   iOS 16.4+ Home Screen web apps and Chrome render it on the icon. */
const CACHE = 'opengym-rt-v1'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()))
})

// Badge = how many things the athlete is waiting on (unread notifications +
// pending reward requests + pending bookings), read straight from the API
// with the session cookie.
async function syncBadge() {
  if (typeof self.registration.setAppBadge !== 'function') return
  let n = 0
  try {
    const [n2, w, b] = await Promise.all([
      fetch('./api/notifications', { credentials: 'include' }).then(r => (r.ok ? r.json() : null)),
      fetch('./api/loyalty/wallet', { credentials: 'include' }).then(r => (r.ok ? r.json() : null)),
      fetch('./api/trainer/my-bookings', { credentials: 'include' }).then(r => (r.ok ? r.json() : null))
    ])
    n += ((n2 && n2.notifications) || []).filter(x => !x.read).length
    n += ((w && w.redemptions) || []).filter(x => x.status === 'pending').length
    n += ((b && b.bookings) || []).filter(x => x.status === 'pending').length
  } catch (e) { return }
  try {
    if (n > 0) await self.registration.setAppBadge(n)
    else await self.registration.clearAppBadge()
  } catch (e) { /* permission missing — ignore */ }
}

self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {}
  e.waitUntil((async () => {
    await self.registration.showNotification(data.title || 'openGym', {
      body: data.body || '',
      icon: 'icon-512.png',
      badge: 'icon-180.png',
      tag: data.tag || 'opengym',
      renotify: true
    })
    // refresh the badge right after a push lands (app may be closed)
    await syncBadge()
  })())
})
self.addEventListener('notificationclick', e => {
  e.notification.close()
  if (typeof self.registration.clearAppBadge === 'function') self.registration.clearAppBadge().catch(() => {})
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(clients => {
    const c = clients.find(c => 'focus' in c)
    return c ? c.focus() : self.clients.openWindow('./')
  }))
})

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== location.origin) return
  if (url.pathname.startsWith('/api/')) return    // never cache auth/data

  const isMedia = url.pathname.includes('/img/') || url.pathname.includes('/gif/')
  if (isMedia) {
    e.respondWith(caches.open(CACHE).then(c => c.match(e.request).then(hit =>
      hit || fetch(e.request).then(res => { if (res.ok) c.put(e.request, res.clone()); return res })
    )))
  } else {
    e.respondWith(fetch(e.request).then(res => {
      if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()))
      return res
    }).catch(() => caches.match(e.request).then(hit => hit || caches.match('index.html'))))
  }
})
