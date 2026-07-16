// governance: allow-repo-hygiene file-size-limit cohesive tunnel protocol; splitting would obscure issue #417 review
// Single source of truth for cache-bucket versioning. Bumping VERSION purges
// every prior bucket on activate. The worker's own script URL carries a
// separate ?v= token minted in src/iroh-transport.ts (SERVICE_WORKER_VERSION);
// that token gates the virtual-Iroh route and lives outside this file. Keep
// the two in step when either changes.
const VERSION = 'v11';
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
const bridgeOwners = new Map();
let cacheGeneration = 0;

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
    cacheGeneration += 1;
    appCookies.clear();
    bridgeOwners.clear();
    event.waitUntil(Promise.all([caches.delete(ASSET_CACHE), caches.delete(BLOB_CACHE)]));
  }
});

function appIdForTarget(target) {
  const url = new URL(target, self.location.origin);
  const match = /^\/centraid\/(?!_)([^/]+)(?:\/|$)/.exec(url.pathname);
  if (match) return decodeURIComponent(match[1]);
  const attested = url.searchParams.get('__centraid_app');
  return attested || undefined;
}

function appCookieKey(bridgeId, appId) {
  return `${bridgeId}\u0000${appId || ''}`;
}

function virtualRoute(url) {
  if (!url.pathname.startsWith(IROH_PREFIX)) return undefined;
  const rest = url.pathname.slice(IROH_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash < 1) return undefined;
  const bridgeId = rest.slice(0, slash);
  const target = `${rest.slice(slash)}${url.search}`;
  const appId = appIdForTarget(target);
  return {
    bridgeId,
    target,
    appId,
    sessionCookie: appCookies.get(appCookieKey(bridgeId, appId)),
  };
}

async function inheritedRoute(event) {
  if (!event.clientId) return undefined;
  const client = await self.clients.get(event.clientId);
  if (!client) return undefined;
  const owner = virtualRoute(new URL(client.url));
  if (!owner) return undefined;
  const requestUrl = new URL(event.request.url);
  const appId = appIdForTarget(owner.target);
  return {
    bridgeId: owner.bridgeId,
    target: `${requestUrl.pathname}${requestUrl.search}`,
    appId,
    sessionCookie: appCookies.get(appCookieKey(owner.bridgeId, appId)),
  };
}

function waitForClaim(port) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('bridge claim timed out')), 1000);
    port.addEventListener('message', (event) => {
      if (event.data?.type !== 'claim') return;
      clearTimeout(timeout);
      resolve();
    });
    port.start();
  });
}

async function claimBridgeOwner(route) {
  const candidates = (
    await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  ).filter((client) => !new URL(client.url).pathname.startsWith(IROH_PREFIX));
  if (candidates.length === 0) throw new Error('Open the Centraid PWA to use this app.');
  const currentId = bridgeOwners.get(route.bridgeId);
  const current = candidates.find((client) => client.id === currentId);
  if (current) return current;
  const attempts = candidates.map((client) => {
    const channel = new MessageChannel();
    client.postMessage({ type: 'centraid:iroh-claim', bridgeId: route.bridgeId }, [channel.port2]);
    return waitForClaim(channel.port1).then(() => client);
  });
  const owner = await Promise.any(attempts);
  bridgeOwners.set(route.bridgeId, owner.id);
  return owner;
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
  const client = await claimBridgeOwner(route);
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

// The stable cache key for a tunneled request, namespaced by the opaque
// gateway+vault bridge id (#406). A remembered device reuses that id across
// launches; a vault switch rotates it. Parent-fetched opaque resources also
// carry a shell-overwritten `__centraid_app`, so one app cannot consume a
// shared blob/resource cache entry authorized for another app.
function tunnelCacheKey(route) {
  const target = new URL(route.target, self.location.origin);
  // Presentation parameters are re-asserted by the parent after load. Keeping
  // them out of the key lets a remembered app reopen after an offline theme
  // change and prevents duplicate copies of the same document.
  target.searchParams.delete('theme');
  target.searchParams.delete('bgL');
  target.searchParams.set('__centraid_scope', route.bridgeId);
  if (route.appId) target.searchParams.set('__centraid_app_scope', route.appId);
  return target.toString();
}

function isBlobTarget(route) {
  return new URL(route.target, self.location.origin).pathname.includes(BLOB_MARKER);
}

function isAppDocumentTarget(target) {
  const pathname = new URL(target, self.location.origin).pathname;
  return /^\/centraid\/(?!_)[^/]+\/$/.test(pathname);
}

// A sandboxed same-origin iframe has an opaque principal. Module scripts and
// dynamic query imports therefore use CORS even though their URL is on the PWA
// origin. The virtual tunnel is already restricted by its app-session cookie;
// exposing those shaped response bytes does not widen gateway authority.
function exposeToOpaqueApp(headers) {
  headers.set('access-control-allow-origin', 'null');
  headers.set('cross-origin-resource-policy', 'cross-origin');
}

// Decides whether/where a freshly tunneled response may be cached, from its
// headers alone.
function tunnelCachePlan(status, headers, isBlob, target) {
  if (status !== 200) return undefined; // no redirects, 206/Range, or errors
  const type = (headers.get('content-type') || '').toLowerCase();
  if (type.includes('text/event-stream')) return undefined; // SSE must stay live
  const control = (headers.get('cache-control') || '').toLowerCase();
  const appDocument = isAppDocumentTarget(target) && type.includes('text/html');
  // The gateway's app document is intentionally browser-no-store because its
  // CSP nonce changes per response. A remembered device's scope-private SW
  // bucket is the one explicit exception: replaying the whole response keeps
  // its matching nonce intact and enables airplane-mode app switching.
  if (control.includes('no-store') && !appDocument) return undefined;
  const length = Number(headers.get('content-length'));
  if (!Number.isFinite(length) || length <= 0 || length > MAX_ENTRY_BYTES) return undefined;
  if (isBlob) return { bucket: BLOB_CACHE, immutable: true };
  if (appDocument) return { bucket: ASSET_CACHE, immutable: false };
  // Non-blob assets are cacheable only with a validator to revalidate against.
  if (!headers.get('etag')) return undefined;
  return { bucket: ASSET_CACHE, immutable: false };
}

async function storeTunnelResponse(plan, key, response, generation = cacheGeneration) {
  try {
    const body = await response.arrayBuffer();
    if (generation !== cacheGeneration) return;
    const headers = new Headers(response.headers);
    // decodedResponse removes the compressed wire length. Persist the actual
    // cached size so the blob LRU cannot treat gzip-decoded entries as free.
    headers.set('content-length', String(body.byteLength));
    headers.set('x-centraid-cached-at', String(Date.now()));
    const cache = await caches.open(plan.bucket);
    if (generation !== cacheGeneration) return;
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
async function revalidateAsset(route, key, etag, isBlob = false) {
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
  if (head.status === 401 || head.status === 403) {
    port.close();
    appCookies.delete(appCookieKey(route.bridgeId, route.appId));
    cacheGeneration += 1;
    await Promise.all([caches.delete(ASSET_CACHE), caches.delete(BLOB_CACHE)]);
    return;
  }
  const headers = buildResponseHeaders(head.headers);
  // Plan off the on-wire headers (they still carry content-length) before
  // decodedResponse strips the compression headers.
  exposeToOpaqueApp(headers);
  const plan = tunnelCachePlan(head.status, headers, isBlob, route.target);
  if (!plan) {
    await drainPort(port).catch(() => undefined);
    return;
  }
  await storeTunnelResponse(plan, key, decodedResponse(portStream(port), 200, headers));
}

async function tunnel(event, initialRoute) {
  const method = event.request.method;
  // Ephemeral bridge ids are deliberately cache-blind: neither reads nor
  // writes may touch Cache Storage when "Remember this device" is off.
  const durableCache = initialRoute.bridgeId.startsWith('d-');
  const cacheable = durableCache && method === 'GET' && !event.request.headers.has('range');
  const isBlob = cacheable && isBlobTarget(initialRoute);
  const cacheKey = cacheable ? tunnelCacheKey(initialRoute) : undefined;

  // Even a cache hit needs one live shell tab that owns this exact bridge.
  // This binds inherited iframe requests to their owning app before lookup.
  if (cacheable) await claimBridgeOwner(initialRoute);

  // Blobs are content-addressed and immutable: serve straight from cache,
  // never touching the relay.
  if (isBlob) {
    const hit = await caches.open(BLOB_CACHE).then((cache) => cache.match(cacheKey));
    if (hit) {
      // Content bytes are immutable, authorization is not. Revalidate the
      // app session so an online revocation evicts already-cached blobs too.
      event.waitUntil(
        revalidateAsset(initialRoute, cacheKey, hit.headers.get('etag'), true).catch(
          () => undefined,
        ),
      );
      return hit;
    }
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

  const location = firstHeader(head.headers, 'location');
  if (location && [301, 302, 303, 307, 308].includes(head.status)) {
    // Keep the browser-visible path aligned with the gateway's final app
    // path. This makes relative stylesheets, scripts, and asset URLs resolve
    // under the app rather than under /_web/session, without exposing a
    // gateway URL or the app-session cookie to the browser.
    port.close();
    const target = themedRedirectTarget(location, event.request.url);
    const appId = appIdForTarget(target);
    if (cookieLine && appId) {
      appCookies.set(appCookieKey(initialRoute.bridgeId, appId), cookieLine.split(';', 1)[0]);
    }
    const virtual = new URL(
      `${IROH_PREFIX}${initialRoute.bridgeId}${target}`,
      self.location.origin,
    ).toString();
    const redirectHeaders = new Headers({ location: virtual });
    exposeToOpaqueApp(redirectHeaders);
    const redirect = new Response(null, { status: head.status, headers: redirectHeaders });
    // The launch URL contains a one-time code. Retain its already-redeemed
    // redirect only inside a durable device scope so the persisted URL can
    // reach the cached stable app document after the network disappears.
    if (cacheable && cacheKey) {
      event.waitUntil(
        caches
          .open(ASSET_CACHE)
          .then((cache) => cache.put(cacheKey, redirect.clone()))
          .catch(() => undefined),
      );
    }
    return redirect;
  }

  const responseHeaders = buildResponseHeaders(head.headers);
  if (head.status === 401 || head.status === 403) {
    appCookies.delete(appCookieKey(initialRoute.bridgeId, initialRoute.appId));
    cacheGeneration += 1;
    await Promise.all([caches.delete(ASSET_CACHE), caches.delete(BLOB_CACHE)]);
  }
  exposeToOpaqueApp(responseHeaders);
  // Plan off the on-wire headers (they still carry content-length) before
  // decodedResponse strips the compression headers.
  const plan = cacheable
    ? tunnelCachePlan(head.status, responseHeaders, isBlob, initialRoute.target)
    : undefined;
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
      const explicit = virtualRoute(url);
      const owner = await inheritedRoute(event);
      // A managed iframe may know its virtual bridge URL, but it cannot use
      // that knowledge to select another app's cookie/cache namespace. Keep
      // an explicit resource target while binding authority to its owning
      // document's bridge and app.
      const route =
        explicit && owner
          ? {
              bridgeId: owner.bridgeId,
              target: explicit.target,
              appId: owner.appId,
              sessionCookie: owner.sessionCookie,
            }
          : (explicit ?? owner);
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
