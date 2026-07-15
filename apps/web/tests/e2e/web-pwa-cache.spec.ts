import { expect, test } from '@playwright/test';

// These tests drive the service worker's tunnel cache directly. The SW asks a
// window client to fulfil `/__centraid_iroh__/...` requests over the
// `centraid:iroh-request` bridge; here the page itself plays that role with a
// synthetic gateway, so the real caching code runs without the Iroh WASM.
async function installFakeBridge(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    interface Call {
      target: string;
      ifNoneMatch: string | null;
      acceptEncoding: string | null;
    }
    const fixture = window as unknown as { __calls: Call[]; __bridgeOffline: boolean };
    fixture.__calls = [];
    fixture.__bridgeOffline = false;
    async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
      const stream = new Response(bytes).body!.pipeThrough(new CompressionStream('gzip'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    navigator.serviceWorker.addEventListener('message', (event) => {
      const msg = event.data as {
        type?: string;
        target?: string;
        headers?: Record<string, string>;
      };
      const port = event.ports[0];
      if (!port || msg?.type !== 'centraid:iroh-request' || !msg.target) return;
      const ifNoneMatch = msg.headers?.['if-none-match'] ?? null;
      (window as unknown as { __calls: Call[] }).__calls.push({
        target: msg.target,
        ifNoneMatch,
        acceptEncoding: msg.headers?.['accept-encoding'] ?? null,
      });
      if (fixture.__bridgeOffline) {
        port.postMessage({ type: 'error', message: 'synthetic airplane mode' });
        return;
      }

      const pathname = new URL(msg.target, 'https://gateway.invalid').pathname;
      if (pathname === '/centraid/_web/session') {
        port.postMessage({
          type: 'head',
          status: 303,
          headers: {
            location: '/centraid/app-fixture/',
            'set-cookie': '__centraid_app=fake; Path=/centraid/; HttpOnly',
          },
        });
        port.postMessage({ type: 'end' });
        return;
      }
      if (pathname === '/centraid/app-fixture/') {
        const bytes = new TextEncoder().encode(
          '<!doctype html><html><head><script type="module" src="_bundle.fixture.js"></script></head><body>offline-app</body></html>',
        );
        port.postMessage({
          type: 'head',
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-length': String(bytes.length),
            'cache-control': 'no-store',
          },
        });
        const buffer = bytes.buffer.slice(0);
        port.postMessage({ type: 'chunk', body: buffer }, [buffer]);
        port.postMessage({ type: 'end' });
        return;
      }
      if (pathname === '/centraid/app-fixture/_bundle.fixture.js') {
        const bytes = new TextEncoder().encode(
          "let blocked=false;try{void parent.document}catch(_){blocked=true}parent.postMessage({type:'sandbox-module-loaded',blocked},'*');",
        );
        port.postMessage({
          type: 'head',
          status: 200,
          headers: {
            'content-type': 'text/javascript',
            'content-length': String(bytes.length),
            'cache-control': 'private,max-age=31536000,immutable',
            etag: '"bundle-etag"',
          },
        });
        const buffer = bytes.buffer.slice(0);
        port.postMessage({ type: 'chunk', body: buffer }, [buffer]);
        port.postMessage({ type: 'end' });
        return;
      }

      // A gzip-encoded asset: the gateway compressed it because the request
      // advertised `accept-encoding: gzip`. The SW must decode it before the
      // page (and the cache) see the body.
      if (msg.target.includes('/gzip-fixture')) {
        if (ifNoneMatch === '"gz-etag-1"') {
          port.postMessage({ type: 'head', status: 304, headers: {} });
          port.postMessage({ type: 'end' });
          return;
        }
        void (async () => {
          const gz = await gzipBytes(new TextEncoder().encode('gzip-decoded-body'));
          port.postMessage({
            type: 'head',
            status: 200,
            headers: {
              'content-type': 'text/javascript',
              'content-length': String(gz.length),
              'content-encoding': 'gzip',
              'cache-control': 'private,no-cache',
              etag: '"gz-etag-1"',
            },
          });
          const buffer = gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength);
          port.postMessage({ type: 'chunk', body: buffer }, [buffer]);
          port.postMessage({ type: 'end' });
        })();
        return;
      }

      const isBlob = msg.target.includes('/_vault/blobs/');
      const bytes = new TextEncoder().encode(isBlob ? 'BLOBDATA' : 'asset-body');
      if (!isBlob && ifNoneMatch === '"etag-1"') {
        // Asset revalidation: unchanged.
        port.postMessage({ type: 'head', status: 304, headers: {} });
        port.postMessage({ type: 'end' });
        return;
      }
      port.postMessage({
        type: 'head',
        status: 200,
        headers: isBlob
          ? {
              'content-type': 'application/octet-stream',
              'content-length': String(bytes.length),
              'cache-control': 'private,max-age=31536000,immutable',
            }
          : {
              'content-type': 'text/javascript',
              'content-length': String(bytes.length),
              'cache-control': 'private,no-cache',
              etag: '"etag-1"',
            },
      });
      const buffer = bytes.buffer.slice(0);
      port.postMessage({ type: 'chunk', body: buffer }, [buffer]);
      port.postMessage({ type: 'end' });
    });
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // The shell registers the worker lazily on first app use; register it up
  // front so these worker-focused tests have a controller to talk to.
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
  });
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
  await installFakeBridge(page);
});

test('immutable blobs are served from cache without a second relay round trip', async ({
  page,
}) => {
  const url = '/__centraid_iroh__/d-bridge-a/centraid/_vault/blobs/sha-fixture';
  const first = await page.evaluate((u) => fetch(u).then((r) => r.text()), url);
  expect(first).toBe('BLOBDATA');

  // Second fetch must hit the blob cache (cache-first) and never reach the bridge.
  const second = await page.evaluate((u) => fetch(u).then((r) => r.text()), url);
  expect(second).toBe('BLOBDATA');

  const calls = await page.evaluate(
    () => (window as unknown as { __calls: { target: string }[] }).__calls,
  );
  const blobCalls = calls.filter((c) => c.target.includes('/_vault/blobs/'));
  expect(blobCalls.length).toBe(1);
});

test('prewarmed query bundles replay in airplane mode and revalidate with If-None-Match', async ({
  page,
}) => {
  const url = '/__centraid_iroh__/d-bridge-a/centraid/app-fixture/_query/search.mjs';
  expect(
    await page.evaluate(
      (u) =>
        fetch(u).then(async (r) => ({
          body: await r.text(),
          cors: r.headers.get('access-control-allow-origin'),
        })),
      url,
    ),
  ).toEqual({ body: 'asset-body', cors: '*' });

  // Second fetch is served immediately from cache; a background conditional
  // request is issued via the bridge.
  expect(await page.evaluate((u) => fetch(u).then((r) => r.text()), url)).toBe('asset-body');

  await expect
    .poll(async () => {
      const calls = await page.evaluate(
        () => (window as unknown as { __calls: { ifNoneMatch: string | null }[] }).__calls,
      );
      return calls.some((c) => c.ifNoneMatch === '"etag-1"');
    })
    .toBe(true);

  // A 304 keeps the cached bytes intact, and the next (first user-visible)
  // search can import it after the relay disappears.
  await page.evaluate(() => {
    (window as unknown as { __bridgeOffline: boolean }).__bridgeOffline = true;
  });
  expect(await page.evaluate((u) => fetch(u).then((r) => r.text()), url)).toBe('asset-body');
});

test('gzip-encoded tunnel responses are decoded before caching', async ({ page }) => {
  const url = '/__centraid_iroh__/d-bridge-a/centraid/gzip-fixture/asset.js';

  // The page receives the decoded body, not the still-gzipped bytes.
  expect(await page.evaluate((u) => fetch(u).then((r) => r.text()), url)).toBe('gzip-decoded-body');

  // The forwarded request advertised gzip (browsers hide Accept-Encoding, so
  // the SW must add it explicitly for the gateway to compress at all).
  const firstCall = await page.evaluate(
    () => (window as unknown as { __calls: { acceptEncoding: string | null }[] }).__calls[0],
  );
  expect(firstCall.acceptEncoding).toBe('gzip');

  // The cached copy is stored decoded (plain bytes, no content-encoding) —
  // proving decode happened BEFORE the caching layer, so the SWR bucket and
  // its If-None-Match revalidation both operate on plain bytes.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const cache = await caches.open('centraid-tunnel-assets-v10');
        const key = new URL('/centraid/gzip-fixture/asset.js', location.origin);
        key.searchParams.set('__centraid_scope', 'd-bridge-a');
        const cached = await cache.match(key.toString());
        if (!cached) return null;
        return {
          body: await cached.text(),
          encoding: cached.headers.get('content-encoding'),
          length: cached.headers.get('content-length'),
        };
      }),
    )
    .toEqual({ body: 'gzip-decoded-body', encoding: null, length: '17' });

  // Second fetch is served from that cache entry — still decoded.
  expect(await page.evaluate((u) => fetch(u).then((r) => r.text()), url)).toBe('gzip-decoded-body');
});

test('remembered app launch, no-store document, and assets replay in airplane mode', async ({
  page,
}) => {
  const launch =
    '/__centraid_iroh__/d-offline/centraid/_web/session?code=launch-one&theme=dark&bgL=5';
  const online = await page.evaluate(
    (u) => fetch(u).then(async (response) => ({ url: response.url, body: await response.text() })),
    launch,
  );
  expect(online.body).toContain('offline-app');
  expect(new URL(online.url).pathname).toBe('/__centraid_iroh__/d-offline/centraid/app-fixture/');

  await expect
    .poll(() =>
      page.evaluate(async () => {
        const cache = await caches.open('centraid-tunnel-assets-v10');
        const keys = await cache.keys();
        return keys.filter((key) => key.url.includes('__centraid_scope=d-offline')).length;
      }),
    )
    .toBeGreaterThanOrEqual(2);

  await page.evaluate(() => {
    (window as unknown as { __bridgeOffline: boolean }).__bridgeOffline = true;
  });
  const changedTheme =
    '/__centraid_iroh__/d-offline/centraid/_web/session?code=launch-one&theme=light&bgL=95';
  const offline = await page.evaluate(
    (u) => fetch(u).then(async (response) => ({ url: response.url, body: await response.text() })),
    changedTheme,
  );
  expect(offline.body).toContain('offline-app');
  expect(new URL(offline.url).pathname).toBe('/__centraid_iroh__/d-offline/centraid/app-fixture/');
});

test('parent-fetched app bundle runs in an opaque document without shell access', async ({
  page,
}) => {
  const result = await page.evaluate(async (src) => {
    const response = await fetch(src);
    const parsed = new DOMParser().parseFromString(await response.text(), 'text/html');
    const nonce = document
      .querySelector<HTMLMetaElement>('meta[name="centraid-csp-nonce"]')
      ?.getAttribute('content');
    if (!nonce) throw new Error('shell CSP nonce missing');
    for (const script of parsed.querySelectorAll<HTMLScriptElement>('script[src]')) {
      const bundle = await fetch(new URL(script.getAttribute('src')!, response.url));
      script.removeAttribute('src');
      script.textContent = await bundle.text();
      script.setAttribute('nonce', nonce);
    }
    const csp = parsed.createElement('meta');
    csp.httpEquiv = 'Content-Security-Policy';
    csp.content = `default-src 'none'; script-src 'nonce-${nonce}' blob:`;
    parsed.head.prepend(csp);
    const html = `<!doctype html>${parsed.documentElement.outerHTML}`;
    const dataUrl = `data:text/html;charset=utf-8;base64,${btoa(html)}`;
    return new Promise<{ blocked: boolean; opaque: boolean }>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('sandbox module timeout')), 5000);
      const onMessage = (event: MessageEvent): void => {
        if (event.data?.type !== 'sandbox-module-loaded') return;
        window.clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        resolve({
          blocked: event.data.blocked === true,
          opaque: frame.contentDocument === null,
        });
      };
      window.addEventListener('message', onMessage);
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.src = dataUrl;
      document.body.append(frame);
    });
  }, '/__centraid_iroh__/d-sandbox/centraid/_web/session?code=sandbox-one');
  expect(result).toEqual({ blocked: true, opaque: true });
});

test('ephemeral bridge scopes neither read nor write tunnel caches', async ({ page }) => {
  const url = '/__centraid_iroh__/e-private/centraid/app-fixture/app.js';
  expect(await page.evaluate((u) => fetch(u).then((r) => r.text()), url)).toBe('asset-body');
  await page.evaluate(() => {
    (window as unknown as { __bridgeOffline: boolean }).__bridgeOffline = true;
  });
  expect(await page.evaluate((u) => fetch(u).then((r) => r.status), url)).toBe(502);
});

test('unpair purges the tunnel caches but keeps the shell cache', async ({ page }) => {
  await page.evaluate(
    (u) => fetch(u).then((r) => r.text()),
    '/__centraid_iroh__/d-b/centraid/_vault/blobs/x',
  );

  await expect.poll(() => page.evaluate(() => caches.has('centraid-tunnel-blobs-v10'))).toBe(true);

  await page.evaluate(() =>
    navigator.serviceWorker.controller?.postMessage({ type: 'centraid:purge-tunnel-cache' }),
  );

  await expect.poll(() => page.evaluate(() => caches.has('centraid-tunnel-blobs-v10'))).toBe(false);
  await expect
    .poll(() => page.evaluate(() => caches.has('centraid-tunnel-assets-v10')))
    .toBe(false);
  // The generic shell cache is not gateway-specific and survives an unpair.
  expect(await page.evaluate(() => caches.has('centraid-shell-v10'))).toBe(true);
});

test('a fresh worker install purges stale-version caches', async ({ page }) => {
  await page.evaluate(() =>
    caches.open('centraid-shell-legacy').then((c) => c.put('/legacy', new Response('old'))),
  );
  expect(await page.evaluate(() => caches.has('centraid-shell-legacy'))).toBe(true);

  // Register a distinct script URL so the browser treats it as a new worker
  // and re-runs install/activate (a byte-identical URL would be a no-op).
  await page.evaluate(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
    await navigator.serviceWorker.register('/sw.js?upgrade=1');
    await navigator.serviceWorker.ready;
  });

  await expect.poll(() => page.evaluate(() => caches.has('centraid-shell-legacy'))).toBe(false);
  expect(await page.evaluate(() => caches.has('centraid-shell-v10'))).toBe(true);
});
