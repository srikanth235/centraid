import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerResponse } from 'node:http';
import { serveStatic } from './static-server.js';

interface MockRes {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer;
}

function mockRes(): { res: ServerResponse; data: MockRes } {
  const data: MockRes = { statusCode: 0, headers: {}, body: Buffer.alloc(0) };
  const res = {
    statusCode: 0,
    setHeader(k: string, v: string) {
      data.headers[k] = v;
    },
    end(b: Buffer) {
      data.body = b;
      data.statusCode = (this as { statusCode: number }).statusCode || 200;
    },
  } as unknown as ServerResponse;
  Object.defineProperty(res, 'statusCode', {
    get() {
      return data.statusCode;
    },
    set(v: number) {
      data.statusCode = v;
    },
  });
  return { res, data };
}

function newAppDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'centraid-static-server-'));
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, rel);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

describe('serveStatic — CSP + nonce', () => {
  it('injects a fresh nonce on every inline <script> when serving HTML', async () => {
    const dir = newAppDir({
      'index.html':
        '<!doctype html><html><head><script>alert("inline")</script><script src="app.js"></script></head><body></body></html>',
    });
    const { res, data } = mockRes();
    await serveStatic(res, dir, 'index.html', {
      settingsInject: { dataAttrs: { theme: 'dark' } },
    });
    const html = data.body.toString('utf8');
    // Inline script gets a nonce; external src=… script does NOT.
    const inlineMatch = html.match(/<script\s+nonce="([^"]+)">alert/);
    expect(inlineMatch).toBeTruthy();
    expect(html).toMatch(/<script\s+src="app\.js"><\/script>/);
    // CSP header carries the same nonce — the inline script is now whitelisted.
    const csp = data.headers['Content-Security-Policy'];
    expect(csp).toBeTruthy();
    expect(csp).toMatch(
      new RegExp(`script-src 'self' 'nonce-${inlineMatch![1]!.replace(/[/+=]/g, '\\$&')}'`),
    );
  });

  it('does not double-stamp when the inline script already has a nonce', async () => {
    const dir = newAppDir({
      'index.html': '<!doctype html><html><head><script nonce="abc">x</script></head></html>',
    });
    const { res, data } = mockRes();
    await serveStatic(res, dir, 'index.html', { settingsInject: { dataAttrs: { theme: 'dark' } } });
    const html = data.body.toString('utf8');
    // Original `nonce="abc"` is preserved (no double-stamping). A second
    // nonce IS expected on the auto-injected change-bus bridge, which the
    // runtime adds to every served HTML — see `injectChangeBridge`.
    expect(html).toMatch(/<script nonce="abc">/);
    expect(html.match(/<script nonce="abc">/g)?.length).toBe(1);
  });

  it('mints a fresh nonce per response', async () => {
    const dir = newAppDir({ 'index.html': '<html><head><script>x</script></head></html>' });
    const { res: res1, data: d1 } = mockRes();
    const { res: res2, data: d2 } = mockRes();
    await serveStatic(res1, dir, 'index.html', { settingsInject: {} });
    await serveStatic(res2, dir, 'index.html', { settingsInject: {} });
    const n1 = d1.body.toString('utf8').match(/nonce="([^"]+)"/)?.[1];
    const n2 = d2.body.toString('utf8').match(/nonce="([^"]+)"/)?.[1];
    expect(n1 && n2).toBeTruthy();
    expect(n1).not.toBe(n2);
  });

  it("falls back to script-src 'self' for non-HTML responses", async () => {
    const dir = newAppDir({ 'app.js': 'console.log("hi")' });
    const { res, data } = mockRes();
    await serveStatic(res, dir, 'app.js');
    expect(data.headers['Content-Security-Policy']?.includes('nonce-')).toBe(false);
    expect(data.headers['Content-Security-Policy']!).toMatch(/script-src 'self'/);
  });

  it('auto-injects the change-bus bridge into every served HTML', async () => {
    const dir = newAppDir({
      'index.html': '<!doctype html><html><head><title>x</title></head><body></body></html>',
    });
    const { res, data } = mockRes();
    await serveStatic(res, dir, 'index.html', { settingsInject: {} });
    const html = data.body.toString('utf8');
    // Bridge inlines the SSE wiring and the `centraid.onChange` sugar.
    expect(html).toMatch(/centraid\.onChange/);
    expect(html).toMatch(/EventSource\('_changes'\)/);
    expect(html).toMatch(/centraid:datachange/);
    // It sits right after the opening <head>, before any user content.
    expect(html).toMatch(/<head>\s*<script\b[^>]*>\(function\(\)\{/);
    // The CSP nonce stamper has tagged it so script-src 'self' lets it run.
    expect(html).toMatch(/<script nonce="[^"]+">\(function\(\)\{var w=window;w\.centraid/);
  });

  it('skips the bridge inject for HTML without a <head> tag', async () => {
    const dir = newAppDir({ 'index.html': '<html><body>no head</body></html>' });
    const { res, data } = mockRes();
    await serveStatic(res, dir, 'index.html', { settingsInject: {} });
    const html = data.body.toString('utf8');
    expect(html).not.toMatch(/centraid:datachange/);
  });

  it('does not inject the bridge into non-HTML responses', async () => {
    const dir = newAppDir({ 'app.js': "console.log('hi')" });
    const { res, data } = mockRes();
    await serveStatic(res, dir, 'app.js');
    const body = data.body.toString('utf8');
    expect(body).not.toMatch(/centraid:datachange/);
    expect(body).not.toMatch(/centraid\.onChange/);
  });

  it('bakes data attrs onto <html> via settingsInject', async () => {
    const dir = newAppDir({ 'index.html': '<html><head></head><body></body></html>' });
    const { res, data } = mockRes();
    await serveStatic(res, dir, 'index.html', {
      settingsInject: { dataAttrs: { theme: 'dark' }, cssVars: { 'bg-l': '5%' } },
    });
    const html = data.body.toString('utf8');
    expect(html).toMatch(/<html data-theme="dark" style="--bg-l:5%">/);
  });
});

describe('serveStatic — shared kit asset fallback', () => {
  it('serves kit.js / kit.css from sharedAssetsDir when the app has no copy', async () => {
    const appDir = newAppDir({ 'index.html': '<html></html>' }); // no kit.js
    const sharedAssetsDir = newAppDir({
      'kit.js': 'export const KIT = 1;',
      'kit.css': '.kit{color:red}',
    });
    const js = mockRes();
    await serveStatic(js.res, appDir, 'kit.js', { sharedAssetsDir });
    expect(js.data.statusCode).toBe(200);
    expect(js.data.body.toString('utf8')).toBe('export const KIT = 1;');
    expect(js.data.headers['Content-Type']).toMatch(/javascript/);

    const css = mockRes();
    await serveStatic(css.res, appDir, 'kit.css', { sharedAssetsDir });
    expect(css.data.statusCode).toBe(200);
    expect(css.data.body.toString('utf8')).toBe('.kit{color:red}');
    expect(css.data.headers['Content-Type']).toMatch(/css/);
  });

  it("prefers the app's own copy over the shared one", async () => {
    const appDir = newAppDir({ 'kit.js': 'export const KIT = "app";' });
    const sharedAssetsDir = newAppDir({ 'kit.js': 'export const KIT = "shared";' });
    const { res, data } = mockRes();
    await serveStatic(res, appDir, 'kit.js', { sharedAssetsDir });
    expect(data.body.toString('utf8')).toBe('export const KIT = "app";');
  });

  it('404s a missing kit asset when no sharedAssetsDir is configured', async () => {
    const appDir = newAppDir({ 'index.html': '<html></html>' });
    const { res, data } = mockRes();
    await serveStatic(res, appDir, 'kit.js');
    expect(data.statusCode).toBe(404);
  });

  it('does not fall back for non-whitelisted files', async () => {
    const appDir = newAppDir({ 'index.html': '<html></html>' });
    const sharedAssetsDir = newAppDir({ 'secret.js': 'nope', 'kit.js': 'ok' });
    const { res, data } = mockRes();
    await serveStatic(res, appDir, 'secret.js', { sharedAssetsDir });
    expect(data.statusCode).toBe(404);
  });
});
