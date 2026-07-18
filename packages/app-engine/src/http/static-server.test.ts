// governance: allow-repo-hygiene file-size-limit one suite per served-asset concern of a single module — CSP/nonce, shared fallback, depth-aware JSX transform, ETag/conditional, and compression tiers all exercise serveStatic and share its fixtures
import { describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  utimesSync,
  statSync,
  promises as fsp,
} from 'node:fs';
import zlib from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IncomingMessage, ServerResponse } from 'node:http';
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
    end(b?: Buffer) {
      data.body = b ?? Buffer.alloc(0);
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

/**
 * Minimal request stand-in — `serveStatic` only ever reads
 * `req.headers['if-none-match']` off it. Defaults to no conditional headers
 * (a plain first-time GET); pass `{ 'if-none-match': '"..."' }` to simulate
 * a revalidation request.
 */
function mockReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
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
    await serveStatic(mockReq(), res, dir, 'index.html', {
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
    expect(csp).toContain("media-src 'self' data: blob:");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toMatch(
      new RegExp(`script-src 'self' 'nonce-${inlineMatch![1]!.replace(/[/+=]/g, '\\$&')}'`),
    );
  });

  it('does not double-stamp when the inline script already has a nonce', async () => {
    const dir = newAppDir({
      'index.html': '<!doctype html><html><head><script nonce="abc">x</script></head></html>',
    });
    const { res, data } = mockRes();
    await serveStatic(mockReq(), res, dir, 'index.html', {
      settingsInject: { dataAttrs: { theme: 'dark' } },
    });
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
    await serveStatic(mockReq(), res1, dir, 'index.html', { settingsInject: {} });
    await serveStatic(mockReq(), res2, dir, 'index.html', { settingsInject: {} });
    const n1 = d1.body.toString('utf8').match(/nonce="([^"]+)"/)?.[1];
    const n2 = d2.body.toString('utf8').match(/nonce="([^"]+)"/)?.[1];
    expect(n1 && n2).toBeTruthy();
    expect(n1).not.toBe(n2);
  });

  it("falls back to script-src 'self' for non-HTML responses", async () => {
    const dir = newAppDir({ 'app.js': 'console.log("hi")' });
    const { res, data } = mockRes();
    await serveStatic(mockReq(), res, dir, 'app.js');
    expect(data.headers['Content-Security-Policy']?.includes('nonce-')).toBe(false);
    expect(data.headers['Content-Security-Policy']!).toMatch(/script-src 'self'/);
  });

  it('auto-injects the change-bus bridge into every served HTML', async () => {
    const dir = newAppDir({
      'index.html': '<!doctype html><html><head><title>x</title></head><body></body></html>',
    });
    const { res, data } = mockRes();
    await serveStatic(mockReq(), res, dir, 'index.html', { settingsInject: {} });
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

  it('derives the app id when a browser transport prefixes the app path', async () => {
    const dir = newAppDir({ 'index.html': '<html><head></head><body></body></html>' });
    const { res, data } = mockRes();
    await serveStatic(mockReq(), res, dir, 'index.html', { settingsInject: {} });
    const html = data.body.toString('utf8');
    // Iroh serves the app under /__centraid_iroh__/<bridge>/centraid/<app>/.
    // The bridge must still identify the app for its scoped tool calls.
    expect(html).toContain('(?:^|\\/)centraid\\/([^/]+)\\/');
  });

  it('skips the bridge inject for HTML without a <head> tag', async () => {
    const dir = newAppDir({ 'index.html': '<html><body>no head</body></html>' });
    const { res, data } = mockRes();
    await serveStatic(mockReq(), res, dir, 'index.html', { settingsInject: {} });
    const html = data.body.toString('utf8');
    expect(html).not.toMatch(/centraid:datachange/);
  });

  it('does not inject the bridge into non-HTML responses', async () => {
    const dir = newAppDir({ 'app.js': "console.log('hi')" });
    const { res, data } = mockRes();
    await serveStatic(mockReq(), res, dir, 'app.js');
    const body = data.body.toString('utf8');
    expect(body).not.toMatch(/centraid:datachange/);
    expect(body).not.toMatch(/centraid\.onChange/);
  });

  it('bakes data attrs onto <html> via settingsInject', async () => {
    const dir = newAppDir({ 'index.html': '<html><head></head><body></body></html>' });
    const { res, data } = mockRes();
    await serveStatic(mockReq(), res, dir, 'index.html', {
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
    await serveStatic(mockReq(), js.res, appDir, 'kit.js', { sharedAssetsDir });
    expect(js.data.statusCode).toBe(200);
    expect(js.data.body.toString('utf8')).toBe('export const KIT = 1;');
    expect(js.data.headers['Content-Type']).toMatch(/javascript/);

    const css = mockRes();
    await serveStatic(mockReq(), css.res, appDir, 'kit.css', { sharedAssetsDir });
    expect(css.data.statusCode).toBe(200);
    expect(css.data.body.toString('utf8')).toBe('.kit{color:red}');
    expect(css.data.headers['Content-Type']).toMatch(/css/);
  });

  it('serves the kit Web Component module (elements.js) from the shared dir', async () => {
    // kit.js does `import './elements.js'` (issue #327's native custom
    // elements, dependency-free — no further runtime import of their own).
    // It's a same-origin relative ESM import that must fall back to the
    // shared dir the same way kit.js does, or the import 404s.
    const appDir = newAppDir({ 'index.html': '<html></html>' }); // no kit files
    const sharedAssetsDir = newAppDir({
      'elements.js': 'export const KitElement = class {};',
    });

    const els = mockRes();
    await serveStatic(mockReq(), els.res, appDir, 'elements.js', { sharedAssetsDir });
    expect(els.data.statusCode).toBe(200);
    expect(els.data.body.toString('utf8')).toBe('export const KitElement = class {};');
    expect(els.data.headers['Content-Type']).toMatch(/javascript/);
  });

  it("prefers the app's own copy over the shared one", async () => {
    const appDir = newAppDir({ 'kit.js': 'export const KIT = "app";' });
    const sharedAssetsDir = newAppDir({ 'kit.js': 'export const KIT = "shared";' });
    const { res, data } = mockRes();
    await serveStatic(mockReq(), res, appDir, 'kit.js', { sharedAssetsDir });
    expect(data.body.toString('utf8')).toBe('export const KIT = "app";');
  });

  it('404s a missing kit asset when no sharedAssetsDir is configured', async () => {
    const appDir = newAppDir({ 'index.html': '<html></html>' });
    const { res, data } = mockRes();
    await serveStatic(mockReq(), res, appDir, 'kit.js');
    expect(data.statusCode).toBe(404);
  });

  it('does not fall back for non-whitelisted files', async () => {
    const appDir = newAppDir({ 'index.html': '<html></html>' });
    const sharedAssetsDir = newAppDir({ 'secret.js': 'nope', 'kit.js': 'ok' });
    const { res, data } = mockRes();
    await serveStatic(mockReq(), res, appDir, 'secret.js', { sharedAssetsDir });
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
    await serveStatic(mockReq(), react.res, appDir, 'react-core.min.js', { sharedAssetsDir });
    expect(react.data.statusCode).toBe(200);
    expect(react.data.body.toString('utf8')).toBe('export const React = {};');
    expect(react.data.headers['Content-Type']).toMatch(/javascript/);

    const runtime = mockRes();
    await serveStatic(mockReq(), runtime.res, appDir, 'jsx-runtime.js', { sharedAssetsDir });
    expect(runtime.data.statusCode).toBe(200);
    expect(runtime.data.body.toString('utf8')).toBe('export function jsx(){}');
    expect(runtime.data.headers['Content-Type']).toMatch(/javascript/);
  });

  it('serves generated offline browser runtimes from the shared kit', async () => {
    const appDir = newAppDir({ 'index.html': '<html></html>' });
    const sharedAssetsDir = newAppDir({
      'blob-format.js': 'export const CBSF_MAGIC = "CBSF";',
      'video-frame.js': 'export const captureVideoFrames = () => {};',
      'pdf.min.mjs': 'export const version = "test";',
      'pdf.worker.min.mjs': 'export const WorkerMessageHandler = {};',
    });
    for (const name of ['blob-format.js', 'video-frame.js', 'pdf.min.mjs', 'pdf.worker.min.mjs']) {
      const served = mockRes();
      await serveStatic(mockReq(), served.res, appDir, name, { sharedAssetsDir });
      expect(served.data.statusCode).toBe(200);
      expect(served.data.headers['Content-Type']).toMatch(/javascript/);
      expect(served.data.body.toString('utf8')).toContain('export const');
    }
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
    await serveStatic(mockReq(), tokens.res, appDir, 'tokens.css', { sharedAssetsDir });
    expect(tokens.data.statusCode).toBe(200);
    expect(tokens.data.body.toString('utf8')).toBe(':root{--app-hue:222}');
    expect(tokens.data.headers['Content-Type']).toMatch(/css/);

    const wall = mockRes();
    await serveStatic(mockReq(), wall.res, appDir, 'wall.css', { sharedAssetsDir });
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
    await serveStatic(mockReq(), res, appDir, 'wall.css', { sharedAssetsDir });
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
    await serveStatic(mockReq(), res, dir, 'app.jsx');
    expect(data.statusCode).toBe(200);
    expect(data.headers['Content-Type']).toMatch(/javascript/);
    const body = data.body.toString('utf8');
    expect(body).not.toMatch(/<div/);
    expect(body).toMatch(/from\s+["']\.\/jsx-runtime\.js["']/);
  });

  it('carries the same security headers as .js (nosniff, CSP)', async () => {
    const dir = newAppDir({ 'app.jsx': VALID_JSX, 'app.js': 'console.log(1)' });
    const jsx = mockRes();
    await serveStatic(mockReq(), jsx.res, dir, 'app.jsx');
    const js = mockRes();
    await serveStatic(mockReq(), js.res, dir, 'app.js');
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
    await serveStatic(mockReq(), first.res, dir, 'app.jsx');
    expect(first.data.body.toString('utf8')).toMatch(/className:\s*["']ok["']|"ok"/);

    // Overwrite with different JSX and bump mtime forward — FS timestamp
    // granularity can be coarse (1s on some filesystems), so jump well past
    // whatever the original mtime was rather than relying on wall-clock delay.
    writeFileSync(file, VALID_JSX_V2);
    const bumped = new Date(statSync(file).mtimeMs + 2000);
    utimesSync(file, bumped, bumped);

    const second = mockRes();
    await serveStatic(mockReq(), second.res, dir, 'app.jsx');
    const secondBody = second.data.body.toString('utf8');
    expect(secondBody).toMatch(/"v2"/);
    expect(secondBody).not.toMatch(/"ok"/);
  });

  it('serves the error shim for broken JSX (200, JS content-type, contains the esbuild message) without poisoning the cache', async () => {
    const dir = newAppDir({ 'app.jsx': BROKEN_JSX });
    const file = join(dir, 'app.jsx');

    const broken = mockRes();
    await serveStatic(mockReq(), broken.res, dir, 'app.jsx');
    expect(broken.data.statusCode).toBe(200);
    expect(broken.data.headers['Content-Type']).toMatch(/javascript/);
    const brokenBody = broken.data.body.toString('utf8');
    expect(brokenBody).toMatch(/console\.error\(/);
    // The esbuild message should be present in the shim body somewhere.
    expect(brokenBody.length).toBeGreaterThan('console.error();'.length);

    // Requesting again without any change must not re-run esbuild into a
    // different (or successful) result — same broken body served again.
    const brokenAgain = mockRes();
    await serveStatic(mockReq(), brokenAgain.res, dir, 'app.jsx');
    expect(brokenAgain.data.body.toString('utf8')).toBe(brokenBody);

    // Fix the file, bump mtime — the next request must serve the real
    // transformed code, proving the failure wasn't cached as a permanent
    // success/negative-result keyed off something other than mtime.
    writeFileSync(file, VALID_JSX);
    const bumped = new Date(statSync(file).mtimeMs + 2000);
    utimesSync(file, bumped, bumped);

    const fixed = mockRes();
    await serveStatic(mockReq(), fixed.res, dir, 'app.jsx');
    expect(fixed.data.statusCode).toBe(200);
    const fixedBody = fixed.data.body.toString('utf8');
    expect(fixedBody).not.toMatch(/console\.error\(/);
    expect(fixedBody).not.toMatch(/<div/);
  });

  it('transforms .jsx in draft-context serving too (mobile/live and draft share the same path)', async () => {
    const dir = newAppDir({ 'app.jsx': VALID_JSX });
    const { res, data } = mockRes();
    await serveStatic(mockReq(), res, dir, 'app.jsx', {
      draft: { appId: 'myapp', sessionId: 'sess1' },
    });
    expect(data.statusCode).toBe(200);
    expect(data.headers['Content-Type']).toMatch(/javascript/);
    const body = data.body.toString('utf8');
    expect(body).not.toMatch(/<div/);
    expect(body).toMatch(/from\s+["']\.\/jsx-runtime\.js["']/);
  });

  // Multi-file React apps: `app.jsx` imports `./components/X.jsx`, so nested
  // .jsx files must transform too. esbuild's emitted `./jsx-runtime` import
  // is resolved by the BROWSER relative to the importing file's own
  // directory, so a nested file needs a specifier that climbs back up to the
  // app root (`jsx-runtime.js` only ever lives there) rather than a bare
  // `./jsx-runtime.js`, which would 404 one directory too deep. Both
  // behaviors are load-bearing for the componentized docs/photos apps.
  it('transforms a nested components/*.jsx file, climbing one level for jsx-runtime', async () => {
    const dir = newAppDir({ 'components/Widget.jsx': VALID_JSX });
    const { res, data } = mockRes();
    await serveStatic(mockReq(), res, dir, 'components/Widget.jsx', {});
    expect(data.statusCode).toBe(200);
    const body = data.body.toString('utf8');
    expect(body).not.toMatch(/<div/);
    expect(body).toMatch(/from\s+["']\.\.\/jsx-runtime\.js["']/);
  });

  it('climbs two levels for a doubly-nested .jsx file', async () => {
    const dir = newAppDir({ 'components/deep/Widget.jsx': VALID_JSX });
    const { res, data } = mockRes();
    await serveStatic(mockReq(), res, dir, 'components/deep/Widget.jsx', {});
    expect(data.statusCode).toBe(200);
    const body = data.body.toString('utf8');
    expect(body).toMatch(/from\s+["']\.\.\/\.\.\/jsx-runtime\.js["']/);
  });

  it('never serves a cached rewrite from the wrong depth for identical file content', async () => {
    // Same JSX source, requested at three different depths in three
    // different app dirs — each must get its own climb prefix. This guards
    // the depth component of the jsxCache key: if the cache were keyed on
    // file path alone (or file content), a root-level request following a
    // nested one could serve the nested file's `../jsx-runtime.js` rewrite.
    const rootDir = newAppDir({ 'app.jsx': VALID_JSX });
    const nestedDir = newAppDir({ 'components/Widget.jsx': VALID_JSX });
    const deepDir = newAppDir({ 'components/deep/Widget.jsx': VALID_JSX });

    const nested = mockRes();
    await serveStatic(mockReq(), nested.res, nestedDir, 'components/Widget.jsx', {});
    expect(nested.data.body.toString('utf8')).toMatch(/from\s+["']\.\.\/jsx-runtime\.js["']/);

    const root = mockRes();
    await serveStatic(mockReq(), root.res, rootDir, 'app.jsx', {});
    expect(root.data.body.toString('utf8')).toMatch(/from\s+["']\.\/jsx-runtime\.js["']/);
    expect(root.data.body.toString('utf8')).not.toMatch(/\.\.\/jsx-runtime\.js/);

    const deep = mockRes();
    await serveStatic(mockReq(), deep.res, deepDir, 'components/deep/Widget.jsx', {});
    expect(deep.data.body.toString('utf8')).toMatch(/from\s+["']\.\.\/\.\.\/jsx-runtime\.js["']/);

    // Re-request the nested one again — still its own depth, not clobbered
    // by the root or deep requests that ran after it.
    const nestedAgain = mockRes();
    await serveStatic(mockReq(), nestedAgain.res, nestedDir, 'components/Widget.jsx', {});
    expect(nestedAgain.data.body.toString('utf8')).toMatch(/from\s+["']\.\.\/jsx-runtime\.js["']/);
    expect(nestedAgain.data.body.toString('utf8')).not.toMatch(/\.\.\/\.\.\/jsx-runtime\.js/);
  });

  it('404s a nested shared-asset request instead of silently serving the shared copy', async () => {
    // The old basename-keyed fallback used to serve this 200 — that's the
    // exact bug this depth-aware rewrite fixes. A nested request for a
    // shared-asset name now has no legitimate source (see the doc comment on
    // SHARED_ASSET_FILES) and must 404 loudly rather than mask a future
    // depth-rewrite regression.
    const dir = newAppDir({ 'components/Widget.jsx': VALID_JSX }); // no jsx-runtime.js anywhere
    const sharedAssetsDir = newAppDir({
      'jsx-runtime.js': 'export const RT = 1;',
      'react-core.min.js': 'export const RC = 1;',
    });
    const runtime = mockRes();
    await serveStatic(mockReq(), runtime.res, dir, 'components/jsx-runtime.js', {
      sharedAssetsDir,
    });
    expect(runtime.data.statusCode).toBe(404);

    const react = mockRes();
    await serveStatic(mockReq(), react.res, dir, 'components/react-core.min.js', {
      sharedAssetsDir,
    });
    expect(react.data.statusCode).toBe(404);
  });
});

describe('serveStatic — TypeScript sources + CSS modules', () => {
  // A `.tsx` with both TS type syntax and JSX — the served body must contain
  // neither the type annotations nor the raw JSX, and must carry the
  // depth-aware automatic-runtime import like the `.jsx` path does.
  const VALID_TSX = `interface Props { name: string }
export default function App(props: Props){ const n: number = 1; return <div className="ok">{props.name}{n}</div>; }`;
  // A plain `.ts` (no JSX) — types stripped, no jsx-runtime import needed.
  const VALID_TS = `export const greeting: string = "hi";
interface Q { a: number }
export function total(q: Q): number { return q.a; }`;
  const CSS_MOD = `.foo { color: red; }
.barBaz { font-weight: bold; }`;
  const CSS_MOD_V2 = `.foo { color: blue; }`;

  it('compiles a .tsx file to plain JS: no type syntax, no raw JSX, JS content-type, rewritten runtime import', async () => {
    const dir = newAppDir({ 'app.tsx': VALID_TSX });
    const { res, data } = mockRes();
    await serveStatic(mockReq(), res, dir, 'app.tsx');
    expect(data.statusCode).toBe(200);
    expect(data.headers['Content-Type']).toMatch(/javascript/);
    const body = data.body.toString('utf8');
    expect(body).not.toMatch(/<div/);
    expect(body).not.toMatch(/interface\s+Props/);
    expect(body).not.toMatch(/:\s*number/);
    expect(body).toMatch(/from\s+["']\.\/jsx-runtime\.js["']/);
  });

  it('climbs one level for a nested components/*.tsx jsx-runtime import', async () => {
    const dir = newAppDir({ 'components/Widget.tsx': VALID_TSX });
    const { res, data } = mockRes();
    await serveStatic(mockReq(), res, dir, 'components/Widget.tsx', {});
    expect(data.statusCode).toBe(200);
    const body = data.body.toString('utf8');
    expect(body).not.toMatch(/<div/);
    expect(body).toMatch(/from\s+["']\.\.\/jsx-runtime\.js["']/);
  });

  it('strips types from a plain .ts file (no JSX, JS content-type)', async () => {
    const dir = newAppDir({ 'util.ts': VALID_TS });
    const { res, data } = mockRes();
    await serveStatic(mockReq(), res, dir, 'util.ts');
    expect(data.statusCode).toBe(200);
    expect(data.headers['Content-Type']).toMatch(/javascript/);
    const body = data.body.toString('utf8');
    expect(body).not.toMatch(/interface\s+Q/);
    expect(body).not.toMatch(/:\s*string/);
    expect(body).not.toMatch(/:\s*number/);
    expect(body).toMatch(/greeting/);
    // A no-JSX source needs no runtime import.
    expect(body).not.toMatch(/jsx-runtime/);
  });

  it('serves a *.module.css as a JS module: class-map default export + idempotent style injection, JS content-type', async () => {
    const dir = newAppDir({ 'styles.module.css': CSS_MOD });
    const { res, data } = mockRes();
    await serveStatic(mockReq(), res, dir, 'styles.module.css');
    expect(data.statusCode).toBe(200);
    // NOT text/css — the browser imports it as JS.
    expect(data.headers['Content-Type']).toMatch(/javascript/);
    const body = data.body.toString('utf8');
    // Injects a guarded <style> element carrying the compiled CSS.
    expect(body).toMatch(/document\.createElement\(['"]style['"]\)/);
    expect(body).toMatch(/data-centraid-css-module/);
    expect(body).toMatch(/color: red/);
    // Default-exports the local→hashed class map; camelCase `barBaz` preserved.
    expect(body).toMatch(/foo:\s*["'][^"']*foo[^"']*["']/);
    expect(body).toMatch(/barBaz:\s*["'][^"']*barBaz[^"']*["']/);
    expect(body).toMatch(/export\s*\{[^}]*\bas default\b|export\s+default/);
  });

  it('a plain (non-module) .css still serves verbatim as text/css', async () => {
    const dir = newAppDir({ 'app.css': '.a{color:blue}' });
    const { res, data } = mockRes();
    await serveStatic(mockReq(), res, dir, 'app.css');
    expect(data.statusCode).toBe(200);
    expect(data.headers['Content-Type']).toMatch(/text\/css/);
    expect(data.body.toString('utf8')).toBe('.a{color:blue}');
  });

  it('a *.module.css gets an ETag and re-compiles with a fresh etag+body when edited (mtime bump)', async () => {
    const dir = newAppDir({ 'styles.module.css': CSS_MOD });
    const file = join(dir, 'styles.module.css');

    const first = mockRes();
    await serveStatic(mockReq(), first.res, dir, 'styles.module.css');
    const etag1 = first.data.headers['ETag']!;
    expect(etag1).toMatch(/^"[0-9a-f]{16,}"$/);
    expect(first.data.body.toString('utf8')).toMatch(/color: red/);

    // Unchanged → conditional 304.
    const revalidate = mockRes();
    await serveStatic(
      mockReq({ 'if-none-match': etag1 }),
      revalidate.res,
      dir,
      'styles.module.css',
    );
    expect(revalidate.data.statusCode).toBe(304);

    writeFileSync(file, CSS_MOD_V2);
    const bumped = new Date(statSync(file).mtimeMs + 2000);
    utimesSync(file, bumped, bumped);

    const second = mockRes();
    await serveStatic(mockReq({ 'if-none-match': etag1 }), second.res, dir, 'styles.module.css');
    expect(second.data.statusCode).toBe(200);
    expect(second.data.headers['ETag']).not.toBe(etag1);
    const body2 = second.data.body.toString('utf8');
    expect(body2).toMatch(/color: blue/);
    expect(body2).not.toMatch(/color: red/);
  });
});

describe('serveStatic — ETag / conditional revalidation (issue #356)', () => {
  const VALID_JSX = `export default function App(){ return <div className="ok">hi</div>; }`;
  const VALID_JSX_V2 = `export default function App(){ return <span className="v2">bye</span>; }`;
  const BROKEN_JSX = `export default function App(){ return <div className="ok">hi</div> }}}`;

  it('sends ETag + private,no-cache on a plain .js asset', async () => {
    const dir = newAppDir({ 'app.js': 'console.log(1)' });
    const { res, data } = mockRes();
    await serveStatic(mockReq(), res, dir, 'app.js');
    expect(data.statusCode).toBe(200);
    expect(data.headers['ETag']).toMatch(/^"[0-9a-f]{16,}"$/);
    expect(data.headers['Cache-Control']).toBe('private, no-cache');
  });

  it('sends the same ETag for the same content on repeat requests', async () => {
    const dir = newAppDir({ 'app.js': 'console.log(1)' });
    const first = mockRes();
    await serveStatic(mockReq(), first.res, dir, 'app.js');
    const second = mockRes();
    await serveStatic(mockReq(), second.res, dir, 'app.js');
    expect(first.data.headers['ETag']).toBe(second.data.headers['ETag']);
  });

  it('304s with empty body + ETag + security headers when If-None-Match matches', async () => {
    const dir = newAppDir({ 'app.js': 'console.log(1)' });
    const first = mockRes();
    await serveStatic(mockReq(), first.res, dir, 'app.js');
    const etag = first.data.headers['ETag']!;

    const second = mockRes();
    await serveStatic(mockReq({ 'if-none-match': etag }), second.res, dir, 'app.js');
    expect(second.data.statusCode).toBe(304);
    expect(second.data.body.length).toBe(0);
    expect(second.data.headers['ETag']).toBe(etag);
    expect(second.data.headers['Cache-Control']).toBe('private, no-cache');
    expect(second.data.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(second.data.headers['Content-Security-Policy']).toBeTruthy();
  });

  it('200s with the full body when If-None-Match is a stale/different etag', async () => {
    const dir = newAppDir({ 'app.js': 'console.log(1)' });
    const { res, data } = mockRes();
    await serveStatic(mockReq({ 'if-none-match': '"not-the-real-etag"' }), res, dir, 'app.js');
    expect(data.statusCode).toBe(200);
    expect(data.body.toString('utf8')).toBe('console.log(1)');
  });

  it('If-None-Match: * always 304s', async () => {
    const dir = newAppDir({ 'app.js': 'console.log(1)' });
    const { res, data } = mockRes();
    await serveStatic(mockReq({ 'if-none-match': '*' }), res, dir, 'app.js');
    expect(data.statusCode).toBe(304);
  });

  it('matches inside a multi-value If-None-Match list', async () => {
    const dir = newAppDir({ 'app.js': 'console.log(1)' });
    const first = mockRes();
    await serveStatic(mockReq(), first.res, dir, 'app.js');
    const etag = first.data.headers['ETag']!;

    const { res, data } = mockRes();
    await serveStatic(
      mockReq({ 'if-none-match': `"deadbeef", ${etag}, "cafebabe"` }),
      res,
      dir,
      'app.js',
    );
    expect(data.statusCode).toBe(304);
  });

  it('shared-fallback assets also carry ETag + private,no-cache', async () => {
    const appDir = newAppDir({ 'index.html': '<html></html>' });
    const sharedAssetsDir = newAppDir({ 'kit.js': 'export const KIT = 1;' });
    const { res, data } = mockRes();
    await serveStatic(mockReq(), res, appDir, 'kit.js', { sharedAssetsDir });
    expect(data.statusCode).toBe(200);
    expect(data.headers['ETag']).toBeTruthy();
    expect(data.headers['Cache-Control']).toBe('private, no-cache');
  });

  it('HTML gets Cache-Control: no-store, no ETag, and ignores If-None-Match (always 200)', async () => {
    const dir = newAppDir({ 'index.html': '<html><head></head><body>hi</body></html>' });

    const first = mockRes();
    await serveStatic(mockReq(), first.res, dir, 'index.html', { settingsInject: {} });
    expect(first.data.statusCode).toBe(200);
    expect(first.data.headers['Cache-Control']).toBe('no-store');
    expect(first.data.headers['ETag']).toBeUndefined();

    // Even a client that (incorrectly) sends If-None-Match against a
    // previously cached HTML body must still get a fresh 200 — HTML is
    // never conditionally served.
    const second = mockRes();
    await serveStatic(mockReq({ 'if-none-match': '"anything"' }), second.res, dir, 'index.html', {
      settingsInject: {},
    });
    expect(second.data.statusCode).toBe(200);
    expect(second.data.body.length).toBeGreaterThan(0);
  });

  it('.jsx ETag changes when the file content+mtime change, 304s when unchanged', async () => {
    const dir = newAppDir({ 'app.jsx': VALID_JSX });
    const file = join(dir, 'app.jsx');

    const first = mockRes();
    await serveStatic(mockReq(), first.res, dir, 'app.jsx');
    const etag1 = first.data.headers['ETag']!;
    expect(etag1).toMatch(/^"[0-9a-f]{16,}"$/);

    // Unchanged file, matching If-None-Match → 304.
    const revalidate = mockRes();
    await serveStatic(mockReq({ 'if-none-match': etag1 }), revalidate.res, dir, 'app.jsx');
    expect(revalidate.data.statusCode).toBe(304);

    // Edit + bump mtime past FS timestamp granularity.
    writeFileSync(file, VALID_JSX_V2);
    const bumped = new Date(statSync(file).mtimeMs + 2000);
    utimesSync(file, bumped, bumped);

    const second = mockRes();
    await serveStatic(mockReq(), second.res, dir, 'app.jsx');
    const etag2 = second.data.headers['ETag']!;
    expect(etag2).not.toBe(etag1);

    // The stale etag from before the edit no longer matches → fresh 200.
    const stale = mockRes();
    await serveStatic(mockReq({ 'if-none-match': etag1 }), stale.res, dir, 'app.jsx');
    expect(stale.data.statusCode).toBe(200);
    expect(stale.data.body.toString('utf8')).toMatch(/"v2"/);
  });

  it('the depth-aware jsx-runtime rewrite (Tier 1) still holds alongside ETag support', async () => {
    const dir = newAppDir({ 'components/Widget.jsx': VALID_JSX });
    const { res, data } = mockRes();
    await serveStatic(mockReq(), res, dir, 'components/Widget.jsx', {});
    expect(data.statusCode).toBe(200);
    expect(data.headers['ETag']).toBeTruthy();
    const body = data.body.toString('utf8');
    expect(body).toMatch(/from\s+["']\.\.\/jsx-runtime\.js["']/);
  });

  it('draft-mode: editing the file yields a new etag and a conditional request returns the new body', async () => {
    const dir = newAppDir({ 'app.jsx': VALID_JSX });
    const file = join(dir, 'app.jsx');
    const draft = { draft: { appId: 'myapp', sessionId: 'sess1' } };

    const first = mockRes();
    await serveStatic(mockReq(), first.res, dir, 'app.jsx', draft);
    const etag1 = first.data.headers['ETag']!;

    // Unchanged → 304 even in draft mode.
    const revalidate = mockRes();
    await serveStatic(mockReq({ 'if-none-match': etag1 }), revalidate.res, dir, 'app.jsx', draft);
    expect(revalidate.data.statusCode).toBe(304);

    writeFileSync(file, VALID_JSX_V2);
    const bumped = new Date(statSync(file).mtimeMs + 2000);
    utimesSync(file, bumped, bumped);

    // Old etag now stale (edited file) → 200 with the new body, not 304.
    const afterEdit = mockRes();
    await serveStatic(mockReq({ 'if-none-match': etag1 }), afterEdit.res, dir, 'app.jsx', draft);
    expect(afterEdit.data.statusCode).toBe(200);
    const body = afterEdit.data.body.toString('utf8');
    expect(body).toMatch(/"v2"/);
    expect(afterEdit.data.headers['ETag']).not.toBe(etag1);
  });

  it('broken-JSX error shim gets an ETag; fixing the file (mtime bump) yields a new etag and 200', async () => {
    const dir = newAppDir({ 'app.jsx': BROKEN_JSX });
    const file = join(dir, 'app.jsx');

    const broken = mockRes();
    await serveStatic(mockReq(), broken.res, dir, 'app.jsx');
    expect(broken.data.statusCode).toBe(200);
    const shimEtag = broken.data.headers['ETag']!;
    expect(shimEtag).toMatch(/^"[0-9a-f]{16,}"$/);

    // Re-requesting the same broken file (no mtime change) revalidates as
    // a 304 against the shim's own etag — proves the shim body is stable
    // and etagged like any other response, not skipped.
    const brokenAgain = mockRes();
    await serveStatic(mockReq({ 'if-none-match': shimEtag }), brokenAgain.res, dir, 'app.jsx');
    expect(brokenAgain.data.statusCode).toBe(304);

    // Fix the file, bump mtime — a request carrying the *old* shim etag
    // must NOT 304 (the shim etag must not leak into the fixed response),
    // and the new response gets its own fresh etag.
    writeFileSync(file, VALID_JSX);
    const bumped = new Date(statSync(file).mtimeMs + 2000);
    utimesSync(file, bumped, bumped);

    const fixed = mockRes();
    await serveStatic(mockReq({ 'if-none-match': shimEtag }), fixed.res, dir, 'app.jsx');
    expect(fixed.data.statusCode).toBe(200);
    expect(fixed.data.headers['ETag']).not.toBe(shimEtag);
    expect(fixed.data.body.toString('utf8')).not.toMatch(/console\.error\(/);
  });
});

describe('serveStatic — compression', () => {
  // A comfortably-over-1KB, highly-compressible JS body.
  const bigJs = `/* banner */\n${'export const x = "yyyyyyyyyy";\n'.repeat(200)}`;

  it('brotli-encodes a large .js asset when the client offers br, with Vary', async () => {
    const dir = newAppDir({ 'app.js': bigJs });
    const { res, data } = mockRes();
    await serveStatic(mockReq({ 'accept-encoding': 'gzip, deflate, br' }), res, dir, 'app.js');
    expect(data.statusCode).toBe(200);
    expect(data.headers['Content-Encoding']).toBe('br');
    expect(data.headers['Vary']).toBe('Accept-Encoding');
    expect(data.body.length).toBeLessThan(Buffer.byteLength(bigJs));
    expect(zlib.brotliDecompressSync(data.body).toString('utf8')).toBe(bigJs);
    // ETag is keyed to the RAW bytes (content identity), not the encoded form.
    expect(data.headers['ETag']).toMatch(/^"[0-9a-f]{16,}"$/);
  });

  it('gzip-encodes when only gzip is offered', async () => {
    const dir = newAppDir({ 'app.js': bigJs });
    const { res, data } = mockRes();
    await serveStatic(mockReq({ 'accept-encoding': 'gzip' }), res, dir, 'app.js');
    expect(data.headers['Content-Encoding']).toBe('gzip');
    expect(zlib.gunzipSync(data.body).toString('utf8')).toBe(bigJs);
  });

  it('ships raw bytes (no Content-Encoding) when the request offers no encoding — SW-path safety', async () => {
    const dir = newAppDir({ 'app.js': bigJs });
    const { res, data } = mockRes();
    await serveStatic(mockReq(), res, dir, 'app.js');
    expect(data.headers['Content-Encoding']).toBeUndefined();
    // Vary is still advertised for the compressible type.
    expect(data.headers['Vary']).toBe('Accept-Encoding');
    expect(data.body.toString('utf8')).toBe(bigJs);
  });

  it('skips compression for a sub-1KB asset even when br is offered', async () => {
    const dir = newAppDir({ 'app.js': 'export const x = 1;' });
    const { res, data } = mockRes();
    await serveStatic(mockReq({ 'accept-encoding': 'br' }), res, dir, 'app.js');
    expect(data.headers['Content-Encoding']).toBeUndefined();
    expect(data.body.toString('utf8')).toBe('export const x = 1;');
  });

  it('never compresses (or Varies) an already-encoded type like PNG', async () => {
    const dir = newAppDir({ 'pic.png': 'P'.repeat(3000) });
    const { res, data } = mockRes();
    await serveStatic(mockReq({ 'accept-encoding': 'br' }), res, dir, 'pic.png');
    expect(data.headers['Content-Encoding']).toBeUndefined();
    expect(data.headers['Vary']).toBeUndefined();
    expect(data.body.length).toBe(3000);
  });

  it('a 304 revalidation still 304s with Accept-Encoding present', async () => {
    const dir = newAppDir({ 'app.js': bigJs });
    const first = mockRes();
    await serveStatic(mockReq({ 'accept-encoding': 'br' }), first.res, dir, 'app.js');
    const etag = first.data.headers['ETag']!;
    const second = mockRes();
    await serveStatic(
      mockReq({ 'accept-encoding': 'br', 'if-none-match': etag }),
      second.res,
      dir,
      'app.js',
    );
    expect(second.data.statusCode).toBe(304);
    expect(second.data.body.length).toBe(0);
  });
});

describe('serveStatic — ETag cache (no re-read on 304 / cached variant)', () => {
  const bigJs = `${'export const x = "zzzzzzzz";\n'.repeat(200)}`;

  it('a matching 304 does not re-read (or re-hash) the file', async () => {
    const dir = newAppDir({ 'app.js': bigJs });
    const warm = mockRes();
    await serveStatic(mockReq(), warm.res, dir, 'app.js'); // populates the cache
    const etag = warm.data.headers['ETag']!;

    const spy = vi.spyOn(fsp, 'readFile');
    try {
      const cond = mockRes();
      await serveStatic(mockReq({ 'if-none-match': etag }), cond.res, dir, 'app.js');
      expect(cond.data.statusCode).toBe(304);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('a repeat compressed hit reuses the cached variant without re-reading', async () => {
    const dir = newAppDir({ 'app.js': bigJs });
    const warm = mockRes();
    await serveStatic(mockReq({ 'accept-encoding': 'br' }), warm.res, dir, 'app.js');

    const spy = vi.spyOn(fsp, 'readFile');
    try {
      const again = mockRes();
      await serveStatic(mockReq({ 'accept-encoding': 'br' }), again.res, dir, 'app.js');
      expect(again.data.headers['Content-Encoding']).toBe('br');
      expect(again.data.body.equals(warm.data.body)).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('an edit (mtime+size change) invalidates the cached etag and serves fresh bytes', async () => {
    const dir = newAppDir({ 'app.js': bigJs });
    const first = mockRes();
    await serveStatic(mockReq(), first.res, dir, 'app.js');
    const etag1 = first.data.headers['ETag']!;

    // Edit to a different length so both mtime and size move.
    writeFileSync(join(dir, 'app.js'), `${bigJs}// appended\n`);
    const after = mockRes();
    await serveStatic(mockReq({ 'if-none-match': etag1 }), after.res, dir, 'app.js');
    expect(after.data.statusCode).toBe(200);
    expect(after.data.headers['ETag']).not.toBe(etag1);
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
