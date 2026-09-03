// governance: allow-repo-hygiene file-size-limit cohesive tunnel protocol; splitting would obscure issue #417 review
// Cache-bucket versioning. Single source is apps/web/src/sw-version.ts —
// `bun run build` runs scripts/stamp-sw-version.mjs which rewrites this line
// (issue #468 K8). Do not hand-bump here.
(() => {
  const VERSION = 'v13';
  const SHELL_CACHE = `centraid-shell-${VERSION}`;
  const ASSET_CACHE = 'centraid-tunnel-assets-' + VERSION;
  const BLOB_CACHE = 'centraid-tunnel-blobs-' + VERSION;
  // Contains only the paired browser's own Iroh device key, current relay
  // ticket and addressed vault. This is the service worker equivalent of the
  // shell's durable localStorage connection record, not a vault-content cache.
  const IROH_CONFIG_CACHE = 'centraid-worker-iroh-config-v1';
  // Shared with gateway-client-push.ts so an open page and a closed PWA use
  // one bounded delivery ledger and never double-notify the same private row.
  const NOTIFICATION_CACHE = 'centraid-private-notification-delivery-v1';
  const CURRENT_CACHES = new Set([
    SHELL_CACHE,
    ASSET_CACHE,
    BLOB_CACHE,
    IROH_CONFIG_CACHE,
    NOTIFICATION_CACHE,
  ]);
  const IROH_CONFIG_KEY = '/__centraid_notifications__/iroh-config';
  const NOTIFICATIONS_DELIVERY_KEY = '/__centraid_notifications__/delivered';
  const REMINDER_DELIVERY_KEY = '/__centraid_notifications__/reminders';
  const WAKE_CONNECT_TIMEOUT_MS = 15000;

  // wasm-bindgen emits ESM while this long-lived worker is intentionally
  // classic. The build derives this versioned classic wrapper from the tracked
  // bindings. Failure leaves ordinary shell/offline behavior intact; a closed
  // wake then falls back to the direct-HTTP control session or a generic alert.
  try {
    importScripts(`/centraid-worker-iroh.js?v=${VERSION}`);
  } catch {
    /* a dev server may not have built the optional worker transport yet */
  }

  // Static shell entries that never change name across builds. Hashed Vite
  // assets are also precached at install by parsing index.html for /assets/*
  // script/link hrefs (issue #468 K4).
  const SHELL = [
    '/',
    '/offline.html',
    '/manifest.webmanifest',
    '/centraid.svg',
    '/icon-192.png',
    '/icon-512.png',
    '/icon-maskable-512.png',
    '/apple-touch-icon-180.png',
  ];
  const IROH_PREFIX = '/__centraid_iroh__/';
  // The ONE Iroh WASM binary (#883 C5). It used to ship twice — a hashed
  // `/assets/` copy for the page's ESM bindings and this unhashed copy for the
  // classic worker — so a visit that used both paid ~2 MB twice. The Vite
  // config now rewrites the bindings' default to this same `?v=`-stamped path,
  // which means the page fetches it too and it must be cacheable here.
  const IROH_WASM_PATH = '/centraid-worker-iroh.wasm';
  /**
   * Content-addressed by construction, so a cache hit is FINAL: hashed
   * `/assets/` names change when their bytes change, and `_headers` pins the
   * worker WASM immutable behind the SW generation token in `?v=`. Stale is not
   * a reachable state for either, which is what lets the fetch path skip the
   * background revalidation it still owes every other shell entry.
   */
  const isImmutableAsset = (url) =>
    url.origin === self.location.origin &&
    (url.pathname.startsWith('/assets/') || url.pathname === IROH_WASM_PATH);
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
  let wakeEndpointPromise;

  /** Extract same-origin /assets/* URLs referenced by the built index.html. */
  async function assetUrlsFromIndex() {
    try {
      const res = await fetch('/');
      if (!res.ok) return [];
      const html = await res.text();
      const found = new Set();
      const re = /(?:src|href)="(?<url>\/assets\/[^"]+)"/gu;
      let match;
      while ((match = re.exec(html))) found.add(match.groups.url);
      return [...found];
    } catch {
      return [];
    }
  }

  // Inline-app chunks are lazy imports absent from index.html; crawl JS transitively and precache CSS for first offline open (#505).
  // Normalize relative Vite paths, bound the crawl, and run it in activate:
  // install must finish the shell cache without waiting on the lazy graph (#883).
  const CHUNK_CRAWL_CEILING = 400;
  const CHUNK_CRAWL_FANOUT = 8;
  async function crawlAssetChunks(seeds, cache) {
    const toAbs = (ref) => (ref[0] === '/' ? ref : `/${ref}`);
    const seen = new Set(seeds.map(toAbs));
    const chunkRe = /\/?assets\/[A-Za-z0-9_.-]+\.(?:js|css)/gu;
    /** Caches one chunk; returns the further `.js` chunks it referenced. */
    const fetchChunk = async (url) => {
      const found = [];
      try {
        const res = await fetch(url);
        if (!res.ok) return found;
        const body = await res.clone().text();
        await cache.put(url, res);
        let match;
        const cssChunks = [];
        // A FRESH matcher per chunk: a shared /g/ regex carries `lastIndex`
        // between the bodies now being read concurrently, which would silently
        // skip references in every chunk after the first.
        const refs = new RegExp(chunkRe.source, chunkRe.flags);
        while ((match = refs.exec(body))) {
          const next = toAbs(match[0]);
          if (seen.has(next)) continue;
          seen.add(next);
          // JS may import further chunks → crawl it; CSS is a leaf → cache now.
          if (next.endsWith('.js')) found.push(next);
          else cssChunks.push(next);
        }
        await Promise.all(cssChunks.map(async (next) => cache.add(next).catch(() => undefined)));
      } catch {
        /* a missing/opaque chunk is skipped — never abort the whole crawl */
      }
      return found;
    };
    const crawlWave = async (wave) => {
      if (wave.length === 0 || seen.size >= CHUNK_CRAWL_CEILING) return;
      const batch = wave.slice(0, CHUNK_CRAWL_FANOUT);
      const deferred = wave.slice(CHUNK_CRAWL_FANOUT);
      const found = await Promise.all(batch.map(fetchChunk));
      return crawlWave([...deferred, ...found.flat()]);
    };
    return crawlWave(seeds.filter((url) => url.endsWith('.js')).map(toAbs));
  }

  self.addEventListener('install', (event) => {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(SHELL_CACHE);
        const assets = await assetUrlsFromIndex();
        await cache.addAll([...SHELL, ...assets]);
      })(),
    );
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
        // Best-effort top-up of the lazy chunk graph (inline app chunks + their
        // deps) so an app opens offline even if it was never opened online.
        // No seeds means no index to crawl from — do not open a shell bucket
        // there is nothing to put in, so an offline activate leaves the cache
        // set exactly as the sweep above left it.
        const seeds = await assetUrlsFromIndex();
        if (seeds.length > 0) {
          const cache = await caches.open(SHELL_CACHE);
          await crawlAssetChunks(seeds, cache).catch(() => undefined);
        }
        // LAST, and the order is a contract. `clients.claim()` is what sets
        // `navigator.serviceWorker.controller`, and both the app-open budget in
        // `tests/e2e/perf-budgets.ts` (appOpen.cold.maxTransferBytes: 8_000)
        // and its probe treat a non-null controller as "every chunk is now
        // answered from Cache Storage". Claiming before the crawl would let an
        // app open against a half-filled cache and pull its chunks over the
        // network. The crawl left `install` (#883 C5); it did not move ahead of
        // this guarantee.
        await self.clients.claim();
      })(),
    );
  });

  async function deliveredKeys(key) {
    try {
      const cache = await caches.open(NOTIFICATION_CACHE);
      const response = await cache.match(key);
      const values = response ? await response.json() : [];
      return new Set(Array.isArray(values) ? values.filter((value) => typeof value === 'string') : []);
    } catch {
      return new Set();
    }
  }

  async function saveDeliveredKeys(key, delivered) {
    const cache = await caches.open(NOTIFICATION_CACHE);
    await cache.put(
      key,
      new Response(JSON.stringify([...delivered].slice(-2000)), {
        headers: { 'content-type': 'application/json' },
      }),
    );
  }

  function decodeBase64(raw) {
    return Uint8Array.from(atob(raw), (char) => char.charCodeAt(0));
  }

  async function loadIrohConfiguration() {
    try {
      const cache = await caches.open(IROH_CONFIG_CACHE);
      const response = await cache.match(IROH_CONFIG_KEY);
      const value = response ? await response.json() : undefined;
      if (
        !value ||
        typeof value.deviceKey !== 'string' ||
        typeof value.endpointTicket !== 'string' ||
        typeof value.vaultId !== 'string'
      )
        return undefined;
      return value;
    } catch {
      return undefined;
    }
  }

  async function closeWakeEndpoint() {
    const current = wakeEndpointPromise;
    wakeEndpointPromise = undefined;
    await current?.then((node) => node.close()).catch(() => undefined);
  }

  async function saveIrohConfiguration(configuration) {
    await closeWakeEndpoint();
    if (!configuration) {
      await caches.delete(IROH_CONFIG_CACHE);
      return;
    }
    const cache = await caches.open(IROH_CONFIG_CACHE);
    await cache.put(
      IROH_CONFIG_KEY,
      new Response(JSON.stringify(configuration), {
        headers: { 'content-type': 'application/json' },
      }),
    );
  }

  async function wakeEndpoint(configuration) {
    const bindings = self.CentraidIrohWorkerBindings;
    if (!bindings) throw new Error('worker Iroh bindings are unavailable');
    if (!wakeEndpointPromise) {
      wakeEndpointPromise = (async () => {
        await bindings.initWasm();
        return bindings.BrowserEndpoint.spawn(
          decodeBase64(configuration.deviceKey),
          undefined,
        );
      })().catch((error) => {
        wakeEndpointPromise = undefined;
        throw error;
      });
    }
    return wakeEndpointPromise;
  }

  async function fetchPrivateOverIroh(path) {
    const configuration = await loadIrohConfiguration();
    if (!configuration) throw new Error('worker Iroh configuration is unavailable');
    const node = await wakeEndpoint(configuration);
    let timer;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('private Iroh wake fetch timed out')),
        WAKE_CONNECT_TIMEOUT_MS,
      );
    });
    let response;
    try {
      response = await Promise.race([
        node.request(
          configuration.endpointTicket,
          'GET',
          path,
          JSON.stringify({
            accept: 'application/json',
            origin: self.location.origin,
            'x-centraid-vault': configuration.vaultId,
          }),
          new Uint8Array(),
        ),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
    const text = await new Response(response.take_body()).text();
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`private Iroh wake fetch returned ${response.status}`);
    }
    return JSON.parse(text);
  }

  // Production app.centraid.dev reaches its sovereign gateway through Iroh,
  // including when no WindowClient exists. A directly hosted same-origin shell
  // can instead reuse its purpose-bound HttpOnly control session.
  async function fetchPrivate(path) {
    try {
      return await fetchPrivateOverIroh(path);
    } catch (irohError) {
      const response = await fetch(
        `/centraid/_web/control?path=${encodeURIComponent(path)}`,
        {
          credentials: 'include',
          headers: { 'x-centraid-service-worker': 'notifications-wake' },
        },
      );
      if (!response.ok) throw irohError;
      return response.json();
    }
  }

  // Mirrors packages/client/src/notifications-model.ts. Content is built
  // only after the authenticated local fetch; the push provider still receives
  // exactly the opaque `replica-wake` marker.
  function composeWebNotifications(notifications, delivered) {
    const decisions = notifications?.decisions || {};
    return [
      ...(decisions.outbox || []).map((row) => ({
        key: `outbox:${row.itemId}:${row.stagedAt}`,
        title:
          ['title', 'subject', 'name']
            .map((field) => row.artifact?.[field])
            .find((value) => typeof value === 'string') || row.target,
        body: 'External write needs your approval',
      })),
      ...(decisions.needsAuth || []).map((row) => ({
        key: `auth:${row.connectionId}:${row.attentionAt}`,
        title: `${row.label} needs reconnection`,
        body: 'Open Notifications to reconnect',
      })),
      ...(decisions.parked || []).map((row) => ({
        key: `parked:${row.invocationId}`,
        title: row.command,
        body: 'A decision is waiting in Notifications',
      })),
      ...(decisions.scopeRequests || []).map((row) => ({
        key: `scope:${row.requestId}`,
        title: `${row.appId} requests access`,
        body: 'Review the requested scope in Notifications',
      })),
      ...(notifications?.notices || [])
        .filter(
          (notice) =>
            notice.severity === 'high' &&
            notice.readAt === null &&
            notice.archivedAt === null,
        )
        .map((notice) => ({
          key: `notice:${notice.noticeId}:${notice.lastAt}`,
          title: notice.headline,
          body: 'Open Notifications for details',
        })),
    ].filter((row) => !delivered.has(row.key));
  }

  async function notifyClosedNotifications() {
    const notifications = await fetchPrivate('/centraid/_vault/notifications');
    const delivered = await deliveredKeys(NOTIFICATIONS_DELIVERY_KEY);
    const rows = composeWebNotifications(notifications, delivered);
    await Promise.all(
      rows.map((row) =>
        self.registration.showNotification(row.title, {
          body: row.body,
          tag: row.key,
          data: { url: '/?notifications=1' },
        }),
      ),
    );
    for (const row of rows) delivered.add(row.key);
    await saveDeliveredKeys(NOTIFICATIONS_DELIVERY_KEY, delivered);
  }

  async function notifyClosedReminders() {
    const body = await fetchPrivate('/centraid/_reminders/due');
    const delivered = await deliveredKeys(REMINDER_DELIVERY_KEY);
    const rows = (body?.reminders || []).filter((row) => !delivered.has(row.key));
    await Promise.all(
      rows.map((row) =>
        self.registration.showNotification(row.title, {
          body:
            row.kind === 'event'
              ? row.minutesBefore === 0
                ? 'Starting now'
                : `Starts in ${row.minutesBefore} minutes`
              : 'Task reminder',
          tag: row.key,
          data: {
            url:
              row.kind === 'event'
                ? `/?agendaEvent=${encodeURIComponent(row.id)}`
                : '/?app=tasks',
          },
        }),
      ),
    );
    for (const row of rows) delivered.add(row.key);
    await saveDeliveredKeys(REMINDER_DELIVERY_KEY, delivered);
  }

  // Web Push carries only an opaque wake marker. An open client performs its
  // authenticated pull. A closed PWA uses its HttpOnly control session to fetch
  // the canonical Notifications/reminder rows and composes private OS content locally.
  self.addEventListener('push', (event) => {
    let wake = false;
    try {
      wake = event.data?.json()?.centraid === 'replica-wake';
    } catch {
      wake = false;
    }
    if (!wake) return;
    event.waitUntil(
      (async () => {
        const clients = await self.clients.matchAll({
          type: 'window',
          includeUncontrolled: true,
        });
        for (const client of clients) {
          // WindowClient.postMessage's second argument is a transfer list, not
          // targetOrigin; the generic postMessage lint rule does not model the
          // service-worker overload. (#630)
          // eslint-disable-next-line unicorn/require-post-message-target-origin -- WindowClient has no targetOrigin argument (#630)
          client.postMessage({ type: 'centraid:push-wake' });
        }
        if (clients.length === 0) {
          let results;
          try {
            results = await Promise.allSettled([
              notifyClosedNotifications(),
              notifyClosedReminders(),
            ]);
          } finally {
            // The next foreground shell will spawn the same enrolled endpoint
            // identity. Release the worker copy after this bounded pull so two
            // live relay registrations never compete for that identity.
            await closeWakeEndpoint();
          }
          if (results.every((result) => result.status === 'rejected')) {
            await self.registration.showNotification('Centraid has updates', {
              body: 'Open Centraid to finish syncing private updates.',
              tag: 'centraid-replica-wake',
              data: { url: '/' },
            });
          }
        }
      })(),
    );
  });

  self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const target = event.notification?.data?.url || '/';
    event.waitUntil(
      self.clients
        .matchAll({ type: 'window', includeUncontrolled: true })
        .then(async (clients) => {
          const client = clients[0];
          if (!client) return self.clients.openWindow(target);
          await client.focus();
          if ('navigate' in client) await client.navigate(target);
          return client;
        }),
    );
  });

  self.addEventListener('message', (event) => {
    // Only same-origin shell clients may configure wake or purge tunnel caches.
    if (event.origin !== self.location.origin) return;
    if (event.data?.type === 'centraid:configure-iroh-wake') {
      event.waitUntil(saveIrohConfiguration(event.data.configuration));
      return;
    }
    // Sent by web-host.ts when the gateway is unpaired: the tunnel caches may
    // hold another gateway/vault's assets, so drop them. Shell cache is generic
    // and stays. This is a separate channel from the iroh-request bridge.
    if (event.data?.type === 'centraid:purge-tunnel-cache') {
      cacheGeneration += 1;
      appCookies.clear();
      bridgeOwners.clear();
      event.waitUntil(
        Promise.all([
          caches.delete(ASSET_CACHE),
          caches.delete(BLOB_CACHE),
          saveIrohConfiguration(undefined),
        ]),
      );
    }
  });

  function appIdForTarget(target) {
    const url = new URL(target, self.location.origin);
    const match = /^\/centraid\/(?!_)(?<appId>[^/]+)(?:\/|$)/u.exec(url.pathname);
    if (match) return decodeURIComponent(match.groups.appId);
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
      client.postMessage({ type: 'centraid:iroh-claim', bridgeId: route.bridgeId }, [
        channel.port2,
      ]);
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
    return waitForHead(channel.port1).then((head) => ({
      head,
      port: channel.port1,
    }));
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
    return /^\/centraid\/(?!_)[^/]+\/$/u.test(pathname);
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
    const matchedEntries = await Promise.all(
      requests.map(async (request) => {
        const cached = await cache.match(request);
        if (!cached) return undefined;
        return {
          request,
          size: Number(cached.headers.get('content-length')) || 0,
          at: Number(cached.headers.get('x-centraid-cached-at')) || 0,
        };
      }),
    );
    const entries = matchedEntries.filter(Boolean);
    let total = 0;
    for (const entry of entries) total += entry.size;
    entries.sort((a, b) => a.at - b.at); // oldest first
    const victims = [];
    while (entries.length && (total > MAX_BLOB_BYTES || entries.length > MAX_BLOB_ENTRIES)) {
      const victim = entries.shift();
      victims.push(victim);
      total -= victim.size;
    }
    await Promise.all(victims.map(async (victim) => cache.delete(victim.request)));
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
      method === 'GET' || method === 'HEAD'
        ? new ArrayBuffer(0)
        : await event.request.arrayBuffer();
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
      const redirect = new Response(null, {
        status: head.status,
        headers: redirectHeaders,
      });
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
    const isNavigation = request.mode === 'navigate';

    const fromNetwork = async () => {
      const preloaded = await event.preloadResponse;
      const response = preloaded || (await fetch(request));
      if (response && response.ok && url.origin === self.location.origin && !noStore) {
        void cache.put(request, response.clone());
      }
      return response;
    };

    // Friendly offline page for navigations (issue #468 K3) — never raw JSON.
    const offlineFallback = async () => {
      if (isNavigation) {
        return (
          (await cache.match('/offline.html')) ||
          (await cache.match('/')) ||
          new Response('You’re offline.', {
            status: 503,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        );
      }
      return cached || (await cache.match('/'));
    };

    if (noStore) return fromNetwork().catch(() => offlineFallback());
    if (cached) {
      // Cache-first, FULL STOP, for content-addressed entries (#883 C5): a
      // hashed chunk or the `?v=`-stamped WASM cannot have gone stale, so the
      // revalidation below was one guaranteed-redundant network request per
      // asset per load, competing with the page's own traffic. Everything else
      // — navigations and unhashed entries, which CAN change under a stable
      // URL — keeps stale-while-revalidate exactly as before: paint from cache
      // now, refresh the entry (and consume any navigation preload) in the
      // background.
      if (!isImmutableAsset(url)) event.waitUntil(fromNetwork().catch(() => undefined));
      return cached;
    }
    return fromNetwork().catch(() => offlineFallback());
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
        if (event.request.method !== 'GET') return fetch(event.request);
        // A `fetch()` issued from JS has an EMPTY destination — which is how
        // the iroh WASM binary is loaded. That bailout meant the one asset big
        // enough to matter (~2 MB) was the only one the shell cache never held,
        // so every visit re-downloaded it (issue #659 C3). Content-addressed
        // paths are immutable by construction, so serving them from the shell
        // cache is always safe; everything else with an empty destination is a
        // data request and still passes straight through. `isImmutableAsset`
        // covers `/centraid-worker-iroh.wasm` as well as `/assets/`, because
        // #883 C5 pointed the page's WASM load at the worker's single copy.
        if (event.request.destination === '' && !isImmutableAsset(url))
          return fetch(event.request);
        return shell(event);
      })().catch(
        (error) =>
          new Response(
            JSON.stringify({
              error: 'iroh_tunnel_error',
              message: String(error),
            }),
            {
              status: 502,
              headers: { 'content-type': 'application/json' },
            },
          ),
      ),
    );
  });
})();
