const CACHE_NAME = 'nian-v158';

// 只预缓存离线壳与图标；JS/CSS 不再预缓存，避免改版后仍吃到旧壳
const SHELL = [
  '/index.html',
  '/manifest.json',
  '/assets/icons/icon.svg',
  '/assets/icons/icon-192.png',
  '/assets/icons/icon-512.png',
  '/assets/icons/apple-touch-icon.png',
];

const OFFLINE_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#100818"><title>念</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#100818;color:#c9a0dc;font-family:system-ui,sans-serif;text-align:center;padding:24px}p{opacity:.85;line-height:1.6}</style></head><body><div><div style="font-size:48px;margin-bottom:12px">念</div><p>网络不可用<br>请连接网络后重试</p></div></body></html>`;

function isCodeAsset(pathname) {
  return /\.(js|css|html|json)$/i.test(pathname) || pathname === '/sw.js';
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))).catch(() => {})
    )
  );
  self.skipWaiting();
});

self.addEventListener('message', (e) => {
  if (e?.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim()).then(() =>
      self.clients.matchAll({ type: 'window' }).then(clients => {
        clients.forEach(c => c.postMessage({ type: 'sw_updated' }));
      })
    )
  );
});

function offlineResponse() {
  return new Response(OFFLINE_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (url.pathname === '/sw.js' || url.pathname === '/manifest.json') {
    e.respondWith(fetch(e.request, { cache: 'no-store' }));
    return;
  }

  // 导航：始终向网络要最新 HTML（校验缓存）
  if (e.request.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const net = await fetch(e.request, { cache: 'no-cache' });
        if (net.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put('/index.html', net.clone());
        }
        return net;
      } catch {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match('/index.html'))
          || (await cache.match('/'))
          || offlineResponse();
      }
    })());
    return;
  }

  // JS/CSS：网络优先 + no-cache，离线才回退本地；不再把代码长期钉死在 SW 里
  if (isCodeAsset(url.pathname)) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const net = await fetch(e.request, { cache: 'no-cache' });
        if (net.ok) cache.put(e.request, net.clone());
        return net;
      } catch {
        return (await cache.match(e.request)) || new Response('', { status: 504, statusText: 'Offline' });
      }
    })());
    return;
  }

  e.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(e.request);
    try {
      const net = await fetch(e.request, { cache: 'no-cache' });
      if (net.ok) cache.put(e.request, net.clone());
      return net;
    } catch {
      if (cached) return cached;
      if (e.request.destination === 'document') return offlineResponse();
      return new Response('', { status: 504, statusText: 'Offline' });
    }
  })());
});

self.addEventListener('push', (e) => {
  if (!e.data) return;
  let data = {};
  try { data = e.data.json(); } catch {}
  e.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (clients.some(c => c.focused)) return;
    const isCall = data.tag && String(data.tag).startsWith('nian-call-');
    await self.registration.showNotification(data.title || '念', {
      body: data.body || '',
      icon: data.icon || '/assets/icons/icon-192.png',
      badge: '/assets/icons/icon-192.png',
      tag: data.tag || 'nian',
      renotify: true,
      vibrate: isCall ? [200, 100, 200, 100, 400] : [80, 40, 80],
      requireInteraction: !!isCall,
      data: data.data || {},
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  const charId = data.charId;
  const open = data.open || (charId ? 'chat' : 'home');
  const url = charId
    ? (open === 'diary' ? `/?open=diary&char=${charId}` : `/?open=chat&char=${charId}${open === 'call' ? '&call=1' : ''}`)
    : (open === 'moments' ? '/?open=moments' : '/');
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if ('focus' in c) {
          c.postMessage({ type: 'notification_open', charId, open: data.open || open, content: data.content || '' });
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
