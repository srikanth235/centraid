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
    (window as unknown as { __calls: Call[] }).__calls = [];
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
  const url = '/__centraid_iroh__/bridge-a/centraid/_vault/blobs/sha-fixture';
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

test('assets are served from cache and revalidated with If-None-Match', async ({ page }) => {
  const url = '/__centraid_iroh__/bridge-a/centraid/app-fixture/app.js';
  expect(await page.evaluate((u) => fetch(u).then((r) => r.text()), url)).toBe('asset-body');

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

  // A 304 keeps the cached bytes intact.
  expect(await page.evaluate((u) => fetch(u).then((r) => r.text()), url)).toBe('asset-body');
});

test('gzip-encoded tunnel responses are decoded before caching', async ({ page }) => {
  const url = '/__centraid_iroh__/bridge-a/centraid/gzip-fixture/asset.js';

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
        const cache = await caches.open('centraid-tunnel-assets-v7');
        const cached = await cache.match(
          new URL('/centraid/gzip-fixture/asset.js', location.origin).toString(),
        );
        if (!cached) return null;
        return { body: await cached.text(), encoding: cached.headers.get('content-encoding') };
      }),
    )
    .toEqual({ body: 'gzip-decoded-body', encoding: null });

  // Second fetch is served from that cache entry — still decoded.
  expect(await page.evaluate((u) => fetch(u).then((r) => r.text()), url)).toBe('gzip-decoded-body');
});

test('unpair purges the tunnel caches but keeps the shell cache', async ({ page }) => {
  await page.evaluate((u) => fetch(u).then((r) => r.text()), '/__centraid_iroh__/b/centraid/_vault/blobs/x');

  await expect
    .poll(() => page.evaluate(() => caches.has('centraid-tunnel-blobs-v7')))
    .toBe(true);

  await page.evaluate(() =>
    navigator.serviceWorker.controller?.postMessage({ type: 'centraid:purge-tunnel-cache' }),
  );

  await expect
    .poll(() => page.evaluate(() => caches.has('centraid-tunnel-blobs-v7')))
    .toBe(false);
  await expect
    .poll(() => page.evaluate(() => caches.has('centraid-tunnel-assets-v7')))
    .toBe(false);
  // The generic shell cache is not gateway-specific and survives an unpair.
  expect(await page.evaluate(() => caches.has('centraid-shell-v7'))).toBe(true);
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

  await expect
    .poll(() => page.evaluate(() => caches.has('centraid-shell-legacy')))
    .toBe(false);
  expect(await page.evaluate(() => caches.has('centraid-shell-v7'))).toBe(true);
});
