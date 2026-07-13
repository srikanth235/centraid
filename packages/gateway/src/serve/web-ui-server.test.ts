import { afterEach, beforeEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startWebUiServer, type WebUiServerHandle } from './web-ui-server.js';

let root: string;
let server: WebUiServerHandle;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-web-ui-'));
  await fs.mkdir(path.join(root, 'assets'));
  await fs.writeFile(path.join(root, 'index.html'), '<!doctype html><div id="root"></div>');
  await fs.writeFile(path.join(root, 'assets', 'app.js'), 'export {};');
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
  expect(csp).toContain('frame-src http://127.0.0.1:8765');
  expect(csp).toContain("frame-ancestors 'none'");
  expect(response.headers.get('cache-control')).toBe('no-store');
});

test('publishes gateway discovery and immutable versioned assets', async () => {
  const config = await fetch(`${server.url}/web-config.json`);
  expect(await config.json()).toEqual({ gatewayUrl: 'http://127.0.0.1:8765' });
  expect(config.headers.get('cache-control')).toBe('no-store');

  const asset = await fetch(`${server.url}/assets/app.js`);
  expect(asset.status).toBe(200);
  expect(asset.headers.get('cache-control')).toContain('immutable');
});

test('unknown client routes fall back to index without escaping the web root', async () => {
  expect((await fetch(`${server.url}/settings/storage`)).status).toBe(200);
  const escaped = await fetch(`${server.url}/..%2F..%2Fetc%2Fpasswd`);
  expect(escaped.status).toBe(200);
  expect(await escaped.text()).toContain('id="root"');
});
