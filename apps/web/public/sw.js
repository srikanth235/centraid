// Single source of truth for cache-bucket versioning. Bumping VERSION purges
// every prior bucket on activate. The worker's own script URL carries a
// separate ?v= token minted in src/iroh-transport.ts (SERVICE_WORKER_VERSION);
// that token gates the virtual-Iroh route and lives outside this file. Keep
// the two in step when either changes.
const VERSION = 'v7';
const SHELL_CACHE = `centraid-shell-${VERSION}`;
const ASSET_CACHE = `centraid-tunnel-assets-${VERSION}`;
const BLOB_CACHE = `centraid-tunnel-blobs-${VERSION}`;
const CURRENT_CACHES = new Set([SHELL_CACHE, ASSET_CACHE, BLOB_CACHE]);

// Static shell entries that never change name across builds. Hashed Vite
// assets are not known to a static worker at install time, so they are
// runtime-cached (stale-while-revalidate) on first navigation instead.
const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/centraid.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon-180.png',
];
const IROH_PREFIX = '/__centraid_iroh__/';
const BLOB_MARKER = '/_vault/blobs/';

// Per-entry buffering cap. Anything larger streams straight through uncached
// so a big video or blob never balloons SW memory.
const MAX_ENTRY_BYTES = 20 * 1024 * 1024;
// Rough LRU ceiling for the content-addressed blob bucket.
const MAX_BLOB_BYTES = 300 * 1024 * 1024;
const MAX_BLOB_ENTRIES = 2000;

const appCookies = new Map();

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => !CURRENT_CACHES.has(key)).map((key) => caches.delete(key)),
      );
      // Speeds up navigations that fall through to the network branch.
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable().catch(() => undefined);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  // Sent by web-host.ts when the gateway is unpaired: the tunnel caches may
  // hold another gateway/vault's assets, so drop them. Shell cache is generic
  // and stays. This is a separate channel from the iroh-request bridge.
  if (event.data?.type === 'centraid:purge-tunnel-cache') {
    event.waitUntil(Promise.all([caches.delete(ASSET_CACHE), caches.delete(BLOB_CACHE)]));
  }
});

function virtualRoute(url) {
  if (!url.pathname.startsWith(IROH_PREFIX)) return undefined;
  const rest = url.pathname.slice(IROH_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash < 1) return undefined;
  return {
    bridgeId: rest.slice(0, slash),
    target: `${rest.slice(slash)}${url.search}`,
    sessionCookie: appCookies.get(rest.slice(0, slash)),
  };
}

async function inheritedRoute(event) {
  if (!event.clientId) return undefined;
  const client = await self.clients.get(event.clientId);
  if (!client) return undefined;
  const owner = virtualRoute(new URL(client.url));
  if (!owner) return undefined;
  const requestUrl = new URL(event.request.url);
  return {
    bridgeId: owner.bridgeId,
    target: `${requestUrl.pathname}${requestUrl.search}`,
    sessionCookie: appCookies.get(owner.bridgeId),
  };
}

function waitForHead(port) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('No browser tab owns this Iroh session.')),
      30000,
    );
    port.addEventListener('message', (event) => {
      if (event.data?.type === 'head') {
        clearTimeout(timeout);
        resolve(event.data);
      } else if (event.data?.type === 'error') {
        clearTimeout(timeout);
        reject(new Error(event.data.message));
      }
    });
    port.start();
  });
}

async function tunnelRequest(route, method, headers, body) {
  const candidates = (
    await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  ).filter((client) => !new URL(client.url).pathname.startsWith(IROH_PREFIX));
  if (candidates.length === 0) throw new Error('Open the Centraid PWA to use this app.');
  const attempts = candidates.map((client) => {
    const channel = new MessageChannel();
    client.postMessage(
      {
        type: 'centraid:iroh-request',
        bridgeId: route.bridgeId,
        target: route.target,
        method,
        headers,
        body: body.slice(0),
        sessionCookie: route.sessionCookie,
      },
      [channel.port2],
    );
    return waitForHead(channel.port1).then((head) => ({ head, port: channel.port1 }));
  });
  return Promise.any(attempts);
}

// Drains a bridge port's chunk stream into the browser Response stream.
function portStream(port) {
  return new ReadableStream({
    start(controller) {
      port.addEventListener('message', (message) => {
        if (message.data?.type === 'chunk') controller.enqueue(new Uint8Array(message.data.body));
        if (message.data?.type === 'end') controller.close();
        if (message.data?.type === 'error') controller.error(new Error(message.data.message));
      });
      port.start();
    },
    cancel() {
      port.close();
    },
  });
}

// Reads a bridge port's chunk stream fully into one buffer (background use).
function drainPort(port) {
  return new Response(portStream(port)).arrayBuffer();
}

// A tunneled response arrives gzip-encoded whenever the request advertised
// `accept-encoding: gzip` (see tunnel()/revalidateAsset()). The browser does
// NOT auto-decode Content-Encoding on a Response synthesized in JS from opaque
// tunnel bytes, so decode here — the single choke point where tunnel frames
// become a Response, and BEFORE the caching layer sees it, so both cache
// buckets store plain bytes and the SWR 200-replace path caches decoded bytes.
// content-encoding + content-length describe the compressed form and are
// stripped. ETag is intentionally kept: the gateway keys it to the RAW
// (decoded) bytes, so If-None-Match revalidation from a cached decoded entry
// stays correct. gzip only — DecompressionStream has no brotli, and the
// request only ever offers gzip (so the server negotiates gzip, never br).
function decodedResponse(stream, status, headers) {
  let decoded = stream;
  if ((headers.get('content-encoding') || '').toLowerCase() === 'gzip') {
    headers.delete('content-encoding');
    headers.delete('content-length');
    decoded = stream.pipeThrough(new DecompressionStream('gzip'));
  }
  return new Response(decoded, { status, headers });
}

function firstHeader(headers, name) {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function buildResponseHeaders(rawHeaders) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(rawHeaders)) {
    if (name.toLowerCase() === 'set-cookie') continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  return headers;
}

function redirectTarget(location) {
  const url = new URL(location, 'http://centraid.invalid');
  if (url.origin !== 'http://centraid.invalid') {
    throw new Error('Gateway app session redirected outside Centraid.');
  }
  return `${url.pathname}${url.search}`;
}

function themedRedirectTarget(location, requestUrl) {
  const target = new URL(redirectTarget(location), 'http://centraid.invalid');
  const source = new URL(requestUrl);
  // The shell adds these presentation options to the one-time session URL.
  // A gateway redirect intentionally knows nothing about them, so preserve
  // them when converting that redirect to a virtual app path.
  for (const name of ['theme', 'bgL']) {
    const value = source.searchParams.get(name);
    if (value !== null && !target.searchParams.has(name)) target.searchParams.set(name, value);
  }
  return `${target.pathname}${target.search}`;
}

// The stable cache key for a tunneled request: the gateway path with the
// per-session bridge id stripped, so a warm relaunch (fresh bridge id) still
// hits the same entry. Cross-vault collisions are bounded by single-gateway
// topology and the unpair purge above.
function tunnelCacheKey(route) {
  return new URL(route.target, self.location.origin).toString();
}

function isBlobTarget(route) {
  return new URL(route.target, self.location.origin).pathname.includes(BLOB_MARKER);
}

// Decides whether/where a freshly tunneled response may be cached, from its
// headers alone.
function tunnelCachePlan(status, headers, isBlob) {
  if (status !== 200) return undefined; // no redirects, 206/Range, or errors
  const type = (headers.get('content-type') || '').toLowerCase();
  if (type.includes('text/event-stream')) return undefined; // SSE must stay live
  const control = (headers.get('cache-control') || '').toLowerCase();
  // App HTML is no-store with a per-response nonce — it must never be cached.
  if (control.includes('no-store')) return undefined;
  const length = Number(headers.get('content-length'));
  if (!Number.isFinite(length) || length <= 0 || length > MAX_ENTRY_BYTES) return undefined;
  if (isBlob) return { bucket: BLOB_CACHE, immutable: true };
  // Non-blob assets are cacheable only with a validator to revalidate against.
  if (!headers.get('etag')) return undefined;
  return { bucket: ASSET_CACHE, immutable: false };
}

async function storeTunnelResponse(plan, key, response) {
  try {
    const body = await response.arrayBuffer();
    const headers = new Headers(response.headers);
    headers.set('x-centraid-cached-at', String(Date.now()));
    const cache = await caches.open(plan.bucket);
    await cache.put(key, new Response(body, { status: 200, headers }));
    if (plan.bucket === BLOB_CACHE) await trimBlobCache(cache);
  } catch {
    /* cache write is best-effort */
  }
}

async function trimBlobCache(cache) {
  const requests = await cache.keys();
  const entries = [];
  let total = 0;
  for (const request of requests) {
    const cached = await cache.match(request);
    if (!cached) continue;
    const size = Number(cached.headers.get('content-length')) || 0;
    const at = Number(cached.headers.get('x-centraid-cached-at')) || 0;
    entries.push({ request, size, at });
    total += size;
  }
  entries.sort((a, b) => a.at - b.at); // oldest first
  while (entries.length && (total > MAX_BLOB_BYTES || entries.length > MAX_BLOB_ENTRIES)) {
    const victim = entries.shift();
    await cache.delete(victim.request);
    total -= victim.size;
  }
}

// Stale-while-revalidate for a cached asset: issue a conditional GET through
// the same bridge contract and replace the entry only when the gateway sends
// fresh bytes (200); a 304 keeps what we served.
async function revalidateAsset(route, key, etag) {
  const { head, port } = await tunnelRequest(
    route,
    'GET',
    // Advertise gzip so the gateway may compress the fresh bytes; the reply is
    // decoded below. Revalidation only ever targets assets, never SSE.
    etag ? { 'if-none-match': etag, 'accept-encoding': 'gzip' } : { 'accept-encoding': 'gzip' },
    new ArrayBuffer(0),
  );
  if (head.status === 304) {
    await drainPort(port).catch(() => undefined); // drain empty body, release port
    return;
  }
  const headers = buildResponseHeaders(head.headers);
  // Plan off the on-wire headers (they still carry content-length) before
  // decodedResponse strips the compression headers.
  const plan = tunnelCachePlan(head.status, headers, false);
  if (!plan) {
    await drainPort(port).catch(() => undefined);
    return;
  }
  await storeTunnelResponse(plan, key, decodedResponse(portStream(port), 200, headers));
}

async function tunnel(event, initialRoute) {
  const method = event.request.method;
  const cacheable = method === 'GET' && !event.request.headers.has('range');
  const isBlob = cacheable && isBlobTarget(initialRoute);
  const cacheKey = cacheable ? tunnelCacheKey(initialRoute) : undefined;

  // Blobs are content-addressed and immutable: serve straight from cache,
  // never touching the relay.
  if (isBlob) {
    const hit = await caches.open(BLOB_CACHE).then((cache) => cache.match(cacheKey));
    if (hit) return hit;
  }
  // Assets already cached are served immediately, then revalidated in the
  // background (stale-while-revalidate).
  if (cacheable && !isBlob) {
    const hit = await caches.open(ASSET_CACHE).then((cache) => cache.match(cacheKey));
    if (hit) {
      event.waitUntil(
        revalidateAsset(initialRoute, cacheKey, hit.headers.get('etag')).catch(() => undefined),
      );
      return hit;
    }
  }

  const headers = Object.fromEntries(event.request.headers.entries());
  // Browsers strip Accept-Encoding from JS-visible request headers, so the
  // tunnel would otherwise forward none and the gateway would ship raw bytes.
  // Advertise gzip explicitly (decodedResponse decodes the reply). Skip SSE:
  // the server exempts text/event-stream anyway, but keep the request honest.
  if (!(event.request.headers.get('accept') || '').includes('text/event-stream')) {
    headers['accept-encoding'] = 'gzip';
  }
  const body =
    method === 'GET' || method === 'HEAD' ? new ArrayBuffer(0) : await event.request.arrayBuffer();
  const { head, port } = await tunnelRequest(initialRoute, method, headers, body);
  const cookieLine = firstHeader(head.headers, 'set-cookie');
  if (cookieLine) appCookies.set(initialRoute.bridgeId, cookieLine.split(';', 1)[0]);

  const location = firstHeader(head.headers, 'location');
  if (location && [301, 302, 303, 307, 308].includes(head.status)) {
    // Keep the browser-visible path aligned with the gateway's final app
    // path. This makes relative stylesheets, scripts, and asset URLs resolve
    // under the app rather than under /_web/session, without exposing a
    // gateway URL or the app-session cookie to the browser.
    port.close();
    const target = themedRedirectTarget(location, event.request.url);
    const virtual = new URL(
      `${IROH_PREFIX}${initialRoute.bridgeId}${target}`,
      self.location.origin,
    ).toString();
    return new Response(null, { status: head.status, headers: { location: virtual } });
  }

  const responseHeaders = buildResponseHeaders(head.headers);
  // Plan off the on-wire headers (they still carry content-length) before
  // decodedResponse strips the compression headers.
  const plan = cacheable ? tunnelCachePlan(head.status, responseHeaders, isBlob) : undefined;
  const response = decodedResponse(portStream(port), head.status, responseHeaders);

  if (plan && cacheKey) {
    // clone() tees the stream, so the browser gets its copy while we buffer
    // ours; the size guard in the plan keeps the buffered branch bounded.
    event.waitUntil(storeTunnelResponse(plan, cacheKey, response.clone()));
  }
  return response;
}

async function shell(event) {
  const request = event.request;
  const url = new URL(request.url);
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  // Never cache /web-config.json: the server marks it no-store because it
  // carries the (mutable) gateway URL. A stale copy could pin the app to a
  // dead gateway.
  const noStore = url.pathname === '/web-config.json';

  const fromNetwork = async () => {
    const preloaded = await event.preloadResponse;
    const response = preloaded || (await fetch(request));
    if (response && response.ok && url.origin === self.location.origin && !noStore) {
      void cache.put(request, response.clone());
    }
    return response;
  };

  if (noStore) return fromNetwork().catch(() => cached || cache.match('/'));
  if (cached) {
    // Stale-while-revalidate: paint from cache now, refresh the entry (and
    // consume any navigation preload) in the background.
    event.waitUntil(fromNetwork().catch(() => undefined));
    return cached;
  }
  return fromNetwork().catch(() => cache.match('/'));
}

self.addEventListener('fetch', (event) => {
  event.respondWith(
    (async () => {
      const url = new URL(event.request.url);
      const route = virtualRoute(url) ?? (await inheritedRoute(event));
      if (route) return tunnel(event, route);
      if (event.request.method !== 'GET' || event.request.destination === '')
        return fetch(event.request);
      return shell(event);
    })().catch(
      (error) =>
        new Response(JSON.stringify({ error: 'iroh_tunnel_error', message: String(error) }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
});
