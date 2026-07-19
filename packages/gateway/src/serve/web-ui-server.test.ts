import { afterEach, beforeEach, expect, test } from 'vitest';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { startWebUiServer, type WebUiServerHandle } from './web-ui-server.js';

let root: string;
let server: WebUiServerHandle;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-web-ui-'));
  await fs.mkdir(path.join(root, 'assets'));
  await fs.writeFile(
    path.join(root, 'index.html'),
    '<!doctype html><head><script type="module" src="/assets/app.js"></script></head><div id="root"></div>',
  );
  await fs.writeFile(path.join(root, 'assets', 'app.js'), 'export {};');
  await fs.writeFile(
    path.join(root, 'assets', 'app.js.br'),
    brotliCompressSync(Buffer.from('export {};')),
  );
  await fs.writeFile(path.join(root, 'assets', 'centraid_web_iroh_bg.wasm'), '\0asm');
  await fs.writeFile(path.join(root, 'sw.js'), 'self.addEventListener("fetch", () => {});');
  await fs.writeFile(path.join(root, 'manifest.webmanifest'), '{"name":"Centraid"}');
  await fs.writeFile(path.join(root, 'centraid.svg'), '<svg/>');
  server = await startWebUiServer({
    rootDir: root,
    apiUrl: 'http://127.0.0.1:8765',
  });
});

afterEach(async () => {
  await server.close();
  await fs.rm(root, { recursive: true, force: true });
});

test('serves the PWA shell with a strict API-and-frame CSP', async () => {
  const response = await fetch(server.url);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('id="root"');
  const csp = response.headers.get('content-security-policy') ?? '';
  expect(csp).toContain("connect-src 'self' http://127.0.0.1:8765");
  expect(csp).toContain("frame-src 'self' data: http://127.0.0.1:8765");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(response.headers.get('cache-control')).toBe('no-store');
});

test('CSP admits the Iroh/WASM transport and opaque self-contained app frame', async () => {
  const response = await fetch(server.url);
  const html = await response.text();
  const csp = response.headers.get('content-security-policy') ?? '';
  // WebAssembly.instantiate needs 'wasm-unsafe-eval' in script-src.
  expect(csp).toContain("script-src 'self' 'nonce-");
  expect(csp).toContain("blob: 'wasm-unsafe-eval'");
  // Browser Iroh is relay-only: it opens a wss:// WebSocket + https to the n0
  // relay. connect-src must admit both while keeping 'self' and the API origin.
  expect(csp).toContain("connect-src 'self' http://127.0.0.1:8765 https: wss:");
  // Iroh-mode apps use a sandboxed data document; direct HTTP retains its API origin.
  expect(csp).toContain("frame-src 'self' data: http://127.0.0.1:8765");
  const nonce = /<meta name="centraid-csp-nonce" content="([^"]+)">/.exec(html)?.[1];
  expect(nonce).toBeTruthy();
  expect(html).toContain(`<script type="module" src="/assets/app.js" nonce="${nonce}">`);
  expect(csp).toContain(`'nonce-${nonce}'`);
  expect(csp).not.toContain("'unsafe-inline' blob:");
});

test('serves .wasm with the application/wasm MIME type for streaming instantiation', async () => {
  const wasm = await fetch(`${server.url}/assets/centraid_web_iroh_bg.wasm`);
  expect(wasm.status).toBe(200);
  expect(wasm.headers.get('content-type')).toBe('application/wasm');
});

test('never pins unhashed root files as year-immutable', async () => {
  // Content-hashed /assets/ files are safe to pin forever.
  const hashed = await fetch(`${server.url}/assets/app.js`);
  expect(hashed.headers.get('cache-control')).toContain('immutable');

  // Stable-URL root files must revalidate — a year-immutable copy would strand
  // redeploys. The service worker + manifest gate updates, so they no-cache.
  const sw = await fetch(`${server.url}/sw.js`);
  expect(sw.headers.get('cache-control')).not.toContain('immutable');
  expect(sw.headers.get('cache-control')).toBe('no-cache');

  const manifest = await fetch(`${server.url}/manifest.webmanifest`);
  expect(manifest.headers.get('cache-control')).not.toContain('immutable');
  expect(manifest.headers.get('cache-control')).toBe('no-cache');

  const icon = await fetch(`${server.url}/centraid.svg`);
  expect(icon.headers.get('cache-control')).not.toContain('immutable');
});

test('publishes gateway discovery and immutable versioned assets', async () => {
  const config = await fetch(`${server.url}/web-config.json`);
  expect(await config.json()).toEqual({ gatewayUrl: 'http://127.0.0.1:8765' });
  expect(config.headers.get('cache-control')).toBe('no-store');

  const asset = await fetch(`${server.url}/assets/app.js`);
  expect(asset.status).toBe(200);
  expect(asset.headers.get('cache-control')).toContain('immutable');
});

test('serves build-time Brotli sidecars without compressing the nonce-stamped shell', async () => {
  const asset = await fetch(`${server.url}/assets/app.js`, {
    headers: { 'accept-encoding': 'br' },
  });
  expect(asset.headers.get('content-encoding')).toBe('br');
  expect(asset.headers.get('vary')).toContain('Accept-Encoding');
  expect(await asset.text()).toBe('export {};');

  const shell = await fetch(server.url, { headers: { 'accept-encoding': 'br' } });
  expect(shell.headers.get('content-encoding')).toBeNull();
});

test('degrades to an ephemeral port instead of failing on a collision', async () => {
  // Occupy a port, then ask the web UI to bind exactly that port. It must not
  // reject (which would take down the whole gateway) — it falls back to an
  // ephemeral port and comes up on a different, listening URL.
  const squatter = http.createServer((_req, res) => res.end());
  await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve));
  const taken = (squatter.address() as AddressInfo).port;

  const collided = await startWebUiServer({
    rootDir: root,
    apiUrl: 'http://127.0.0.1:8765',
    host: '127.0.0.1',
    port: taken,
  });
  try {
    expect(collided.url).not.toBe(`http://127.0.0.1:${taken}`);
    expect((await fetch(collided.url)).status).toBe(200);
  } finally {
    await collided.close();
    await new Promise<void>((resolve) => squatter.close(() => resolve()));
  }
});

test('unknown client routes fall back to index without escaping the web root', async () => {
  expect((await fetch(`${server.url}/settings/storage`)).status).toBe(200);
  const escaped = await fetch(`${server.url}/..%2F..%2Fetc%2Fpasswd`);
  expect(escaped.status).toBe(200);
  expect(await escaped.text()).toContain('id="root"');
});
