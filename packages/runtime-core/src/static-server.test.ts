import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
    assert.ok(inlineMatch, `expected nonce on inline script, got: ${html}`);
    assert.match(html, /<script\s+src="app\.js"><\/script>/);
    // CSP header carries the same nonce — the inline script is now whitelisted.
    const csp = data.headers['Content-Security-Policy'];
    assert.ok(csp, 'expected CSP header');
    assert.match(
      csp,
      new RegExp(`script-src 'self' 'nonce-${inlineMatch[1]!.replace(/[/+=]/g, '\\$&')}'`),
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
    assert.match(html, /<script nonce="abc">/);
    assert.equal(
      html.match(/<script nonce="abc">/g)?.length,
      1,
      'original nonced script should appear exactly once',
    );
  });

  it('mints a fresh nonce per response', async () => {
    const dir = newAppDir({ 'index.html': '<html><head><script>x</script></head></html>' });
    const { res: res1, data: d1 } = mockRes();
    const { res: res2, data: d2 } = mockRes();
    await serveStatic(res1, dir, 'index.html', { settingsInject: {} });
    await serveStatic(res2, dir, 'index.html', { settingsInject: {} });
    const n1 = d1.body.toString('utf8').match(/nonce="([^"]+)"/)?.[1];
    const n2 = d2.body.toString('utf8').match(/nonce="([^"]+)"/)?.[1];
    assert.ok(n1 && n2);
    assert.notEqual(n1, n2);
  });

  it("falls back to script-src 'self' for non-HTML responses", async () => {
    const dir = newAppDir({ 'app.js': 'console.log("hi")' });
    const { res, data } = mockRes();
    await serveStatic(res, dir, 'app.js');
    assert.equal(data.headers['Content-Security-Policy']?.includes('nonce-'), false);
    assert.match(data.headers['Content-Security-Policy']!, /script-src 'self'/);
  });

  it('auto-injects the change-bus bridge into every served HTML', async () => {
    const dir = newAppDir({
      'index.html': '<!doctype html><html><head><title>x</title></head><body></body></html>',
    });
    const { res, data } = mockRes();
    await serveStatic(res, dir, 'index.html', { settingsInject: {} });
    const html = data.body.toString('utf8');
    // Bridge inlines the SSE wiring and the `centraid.onChange` sugar.
    assert.match(html, /centraid\.onChange/);
    assert.match(html, /EventSource\('_changes'\)/);
    assert.match(html, /centraid:datachange/);
    // It sits right after the opening <head>, before any user content.
    assert.match(html, /<head>\s*<script\b[^>]*>\(function\(\)\{/);
    // The CSP nonce stamper has tagged it so script-src 'self' lets it run.
    assert.match(html, /<script nonce="[^"]+">\(function\(\)\{var w=window;w\.centraid/);
  });

  it('skips the bridge inject for HTML without a <head> tag', async () => {
    const dir = newAppDir({ 'index.html': '<html><body>no head</body></html>' });
    const { res, data } = mockRes();
    await serveStatic(res, dir, 'index.html', { settingsInject: {} });
    const html = data.body.toString('utf8');
    assert.doesNotMatch(html, /centraid:datachange/);
  });

  it('does not inject the bridge into non-HTML responses', async () => {
    const dir = newAppDir({ 'app.js': "console.log('hi')" });
    const { res, data } = mockRes();
    await serveStatic(res, dir, 'app.js');
    const body = data.body.toString('utf8');
    assert.doesNotMatch(body, /centraid:datachange/);
    assert.doesNotMatch(body, /centraid\.onChange/);
  });

  it('bakes data attrs onto <html> via settingsInject', async () => {
    const dir = newAppDir({ 'index.html': '<html><head></head><body></body></html>' });
    const { res, data } = mockRes();
    await serveStatic(res, dir, 'index.html', {
      settingsInject: { dataAttrs: { theme: 'dark' }, cssVars: { 'bg-l': '5%' } },
    });
    const html = data.body.toString('utf8');
    assert.match(html, /<html data-theme="dark" style="--bg-l:5%">/);
  });
});
