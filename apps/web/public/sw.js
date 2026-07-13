const CACHE = 'centraid-shell-v6';
const SHELL = ['/', '/manifest.webmanifest', '/centraid.svg'];
const IROH_PREFIX = '/__centraid_iroh__/';
const appCookies = new Map();

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
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
    const timeout = setTimeout(() => reject(new Error('No browser tab owns this Iroh session.')), 30000);
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
  const candidates = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter(
    (client) => !new URL(client.url).pathname.startsWith(IROH_PREFIX),
  );
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

function firstHeader(headers, name) {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
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

async function tunnel(event, initialRoute) {
  const method = event.request.method;
  const headers = Object.fromEntries(event.request.headers.entries());
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

  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(head.headers)) {
    if (name.toLowerCase() === 'set-cookie') continue;
    if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
    else responseHeaders.set(name, value);
  }
  const responseBody = new ReadableStream({
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
  return new Response(responseBody, { status: head.status, headers: responseHeaders });
}

async function shell(request) {
  return fetch(request)
    .then((response) => {
      const url = new URL(request.url);
      // Never cache /web-config.json: the server marks it no-store because it
      // carries the (mutable) gateway URL. A stale copy could pin the app to a
      // dead gateway.
      if (response.ok && url.origin === self.location.origin && url.pathname !== '/web-config.json') {
        const copy = response.clone();
        void caches.open(CACHE).then((cache) => cache.put(request, copy));
      }
      return response;
    })
    .catch(() => caches.match(request).then((cached) => cached || caches.match('/')));
}

self.addEventListener('fetch', (event) => {
  event.respondWith(
    (async () => {
      const url = new URL(event.request.url);
      const route = virtualRoute(url) ?? (await inheritedRoute(event));
      if (route) return tunnel(event, route);
      if (event.request.method !== 'GET' || event.request.destination === '') return fetch(event.request);
      return shell(event.request);
    })().catch(
      (error) =>
        new Response(JSON.stringify({ error: 'iroh_tunnel_error', message: String(error) }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
});
