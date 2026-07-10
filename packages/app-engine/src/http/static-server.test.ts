import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerResponse } from 'node:http';
import { serveStatic } from './static-server.js';
import { resolveStaticPath } from './security.js';

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

  it('serves the kit Web Component modules (elements.js / lit-core.min.js) from the shared dir', async () => {
    // kit.js does `import './elements.js'`, which imports `./lit-core.min.js`
    // (issue #327). Both are same-origin relative ESM imports that must fall
    // back to the shared dir the same way kit.js does, or the import chain 404s.
    const appDir = newAppDir({ 'index.html': '<html></html>' }); // no kit files
    const sharedAssetsDir = newAppDir({
      'elements.js': "import './lit-core.min.js';",
      'lit-core.min.js': 'export const LitElement = class {};',
    });

    const els = mockRes();
    await serveStatic(els.res, appDir, 'elements.js', { sharedAssetsDir });
    expect(els.data.statusCode).toBe(200);
    expect(els.data.body.toString('utf8')).toBe("import './lit-core.min.js';");
    expect(els.data.headers['Content-Type']).toMatch(/javascript/);

    const lit = mockRes();
    await serveStatic(lit.res, appDir, 'lit-core.min.js', { sharedAssetsDir });
    expect(lit.data.statusCode).toBe(200);
    expect(lit.data.body.toString('utf8')).toBe('export const LitElement = class {};');
    expect(lit.data.headers['Content-Type']).toMatch(/javascript/);
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

  it('serves react-core.min.js / jsx-runtime.js from sharedAssetsDir when the app has no copy', async () => {
    // Mirrors the kit.js fallback test above — builder-generated `.jsx` apps
    // (issue in progress: serve-time JSX transform) don't ship their own
    // copies of the vendored React runtime or the automatic-JSX-runtime
    // shim; both must fall back the same way `kit.js` does.
    const appDir = newAppDir({ 'index.html': '<html></html>' });
    const sharedAssetsDir = newAppDir({
      'react-core.min.js': 'export const React = {};',
      'jsx-runtime.js': 'export function jsx(){}',
    });

    const react = mockRes();
    await serveStatic(react.res, appDir, 'react-core.min.js', { sharedAssetsDir });
    expect(react.data.statusCode).toBe(200);
    expect(react.data.body.toString('utf8')).toBe('export const React = {};');
    expect(react.data.headers['Content-Type']).toMatch(/javascript/);

    const runtime = mockRes();
    await serveStatic(runtime.res, appDir, 'jsx-runtime.js', { sharedAssetsDir });
    expect(runtime.data.statusCode).toBe(200);
    expect(runtime.data.body.toString('utf8')).toBe('export function jsx(){}');
    expect(runtime.data.headers['Content-Type']).toMatch(/javascript/);
  });

  it('serves tokens.css / wall.css from sharedAssetsDir when the app has no copy', async () => {
    // Generated by scripts/vendor-tokens.mjs — see packages/design-tokens's
    // toBlueprintCss(). Apps that don't ship their own copy of either file
    // must fall back to the kit's shared dir the same way kit.css does.
    const appDir = newAppDir({ 'index.html': '<html></html>' }); // no tokens.css / wall.css
    const sharedAssetsDir = newAppDir({
      'tokens.css': ':root{--app-hue:222}',
      'wall.css': ":root[data-theme='dark']{--bg-wall:#000}",
    });

    const tokens = mockRes();
    await serveStatic(tokens.res, appDir, 'tokens.css', { sharedAssetsDir });
    expect(tokens.data.statusCode).toBe(200);
    expect(tokens.data.body.toString('utf8')).toBe(':root{--app-hue:222}');
    expect(tokens.data.headers['Content-Type']).toMatch(/css/);

    const wall = mockRes();
    await serveStatic(wall.res, appDir, 'wall.css', { sharedAssetsDir });
    expect(wall.data.statusCode).toBe(200);
    expect(wall.data.body.toString('utf8')).toBe(":root[data-theme='dark']{--bg-wall:#000}");
    expect(wall.data.headers['Content-Type']).toMatch(/css/);
  });

  it("prefers the app's own wall.css over the shared one (pins people's light-mode override)", async () => {
    const appDir = newAppDir({ 'wall.css': ":root[data-theme='light']{--bg-wall:#fff5f0}" });
    const sharedAssetsDir = newAppDir({
      'wall.css': ":root[data-theme='light']{--bg-wall:#fcfcfc}",
    });
    const { res, data } = mockRes();
    await serveStatic(res, appDir, 'wall.css', { sharedAssetsDir });
    expect(data.body.toString('utf8')).toBe(":root[data-theme='light']{--bg-wall:#fff5f0}");
  });
});

describe('serveStatic — serve-time JSX transform', () => {
  const VALID_JSX = `export default function App(){ return <div className="ok">hi</div>; }`;
  const VALID_JSX_V2 = `export default function App(){ return <span className="v2">bye</span>; }`;
  const BROKEN_JSX = `export default function App(){ return <div className="ok">hi</div> }}}`;

  it('compiles a .jsx file to plain JS, content-type matches .js, no raw JSX, rewritten runtime import', async () => {
    const dir = newAppDir({ 'app.jsx': VALID_JSX });
    const { res, data } = mockRes();
    await serveStatic(res, dir, 'app.jsx');
    expect(data.statusCode).toBe(200);
    expect(data.headers['Content-Type']).toMatch(/javascript/);
    const body = data.body.toString('utf8');
    expect(body).not.toMatch(/<div/);
    expect(body).toMatch(/from\s+["']\.\/jsx-runtime\.js["']/);
  });

  it('carries the same security headers as .js (nosniff, CSP)', async () => {
    const dir = newAppDir({ 'app.jsx': VALID_JSX, 'app.js': 'console.log(1)' });
    const jsx = mockRes();
    await serveStatic(jsx.res, dir, 'app.jsx');
    const js = mockRes();
    await serveStatic(js.res, dir, 'app.js');
    expect(jsx.data.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(jsx.data.headers['X-Content-Type-Options']).toBe(
      js.data.headers['X-Content-Type-Options'],
    );
    expect(jsx.data.headers['Content-Security-Policy']).toBeTruthy();
    expect(jsx.data.headers['Content-Security-Policy']).toBe(
      js.data.headers['Content-Security-Policy'],
    );
  });

  it('re-transforms when the file mtime changes (cache invalidation)', async () => {
    const dir = newAppDir({ 'app.jsx': VALID_JSX });
    const file = join(dir, 'app.jsx');

    const first = mockRes();
    await serveStatic(first.res, dir, 'app.jsx');
    expect(first.data.body.toString('utf8')).toMatch(/className:\s*["']ok["']|"ok"/);

    // Overwrite with different JSX and bump mtime forward — FS timestamp
    // granularity can be coarse (1s on some filesystems), so jump well past
    // whatever the original mtime was rather than relying on wall-clock delay.
    writeFileSync(file, VALID_JSX_V2);
    const bumped = new Date(statSync(file).mtimeMs + 2000);
    utimesSync(file, bumped, bumped);

    const second = mockRes();
    await serveStatic(second.res, dir, 'app.jsx');
    const secondBody = second.data.body.toString('utf8');
    expect(secondBody).toMatch(/"v2"/);
    expect(secondBody).not.toMatch(/"ok"/);
  });

  it('serves the error shim for broken JSX (200, JS content-type, contains the esbuild message) without poisoning the cache', async () => {
    const dir = newAppDir({ 'app.jsx': BROKEN_JSX });
    const file = join(dir, 'app.jsx');

    const broken = mockRes();
    await serveStatic(broken.res, dir, 'app.jsx');
    expect(broken.data.statusCode).toBe(200);
    expect(broken.data.headers['Content-Type']).toMatch(/javascript/);
    const brokenBody = broken.data.body.toString('utf8');
    expect(brokenBody).toMatch(/console\.error\(/);
    // The esbuild message should be present in the shim body somewhere.
    expect(brokenBody.length).toBeGreaterThan('console.error();'.length);

    // Requesting again without any change must not re-run esbuild into a
    // different (or successful) result — same broken body served again.
    const brokenAgain = mockRes();
    await serveStatic(brokenAgain.res, dir, 'app.jsx');
    expect(brokenAgain.data.body.toString('utf8')).toBe(brokenBody);

    // Fix the file, bump mtime — the next request must serve the real
    // transformed code, proving the failure wasn't cached as a permanent
    // success/negative-result keyed off something other than mtime.
    writeFileSync(file, VALID_JSX);
    const bumped = new Date(statSync(file).mtimeMs + 2000);
    utimesSync(file, bumped, bumped);

    const fixed = mockRes();
    await serveStatic(fixed.res, dir, 'app.jsx');
    expect(fixed.data.statusCode).toBe(200);
    const fixedBody = fixed.data.body.toString('utf8');
    expect(fixedBody).not.toMatch(/console\.error\(/);
    expect(fixedBody).not.toMatch(/<div/);
  });

  it('transforms .jsx in draft-context serving too (mobile/live and draft share the same path)', async () => {
    const dir = newAppDir({ 'app.jsx': VALID_JSX });
    const { res, data } = mockRes();
    await serveStatic(res, dir, 'app.jsx', { draft: { appId: 'myapp', sessionId: 'sess1' } });
    expect(data.statusCode).toBe(200);
    expect(data.headers['Content-Type']).toMatch(/javascript/);
    const body = data.body.toString('utf8');
    expect(body).not.toMatch(/<div/);
    expect(body).toMatch(/from\s+["']\.\/jsx-runtime\.js["']/);
  });

  // Multi-file React apps: `app.jsx` imports `./components/X.jsx`, so nested
  // .jsx files must transform too, and their emitted `./jsx-runtime.js`
  // import — relative to components/ — must resolve through the shared-asset
  // fallback, which keys on the BASENAME of the missing file. Both behaviors
  // are load-bearing for the componentized docs/photos apps.
  it('transforms a nested components/*.jsx file', async () => {
    const dir = newAppDir({ 'components/Widget.jsx': VALID_JSX });
    const { res, data } = mockRes();
    await serveStatic(res, dir, 'components/Widget.jsx', {});
    expect(data.statusCode).toBe(200);
    const body = data.body.toString('utf8');
    expect(body).not.toMatch(/<div/);
    expect(body).toMatch(/from\s+["']\.\/jsx-runtime\.js["']/);
  });

  it('serves a nested jsx-runtime.js request from the shared dir (basename fallback)', async () => {
    const dir = newAppDir({ 'components/Widget.jsx': VALID_JSX }); // no jsx-runtime.js anywhere
    const sharedAssetsDir = newAppDir({ 'jsx-runtime.js': 'export const RT = 1;' });
    const { res, data } = mockRes();
    await serveStatic(res, dir, 'components/jsx-runtime.js', { sharedAssetsDir });
    expect(data.statusCode).toBe(200);
    expect(data.body.toString('utf8')).toBe('export const RT = 1;');
  });
});

describe('resolveStaticPath — .jsx allowlist', () => {
  it('accepts a .jsx request', () => {
    const dir = newAppDir({ 'app.jsx': 'export default 1;' });
    expect(resolveStaticPath(dir, 'app.jsx')).toBe(join(dir, 'app.jsx'));
  });

  it('still rejects a disallowed extension', () => {
    const dir = newAppDir({ 'app.exe': 'nope' });
    expect(resolveStaticPath(dir, 'app.exe')).toBeNull();
  });
});
