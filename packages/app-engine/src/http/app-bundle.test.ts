// governance: allow-repo-hygiene file-size-limit one suite per concern of the
// whole-app bundling seam (issue #404): HTML rewrite, bundle serving/ETag/304,
// draft exemption, invalidation, shared-asset precedence, JSX runtime, CSS
// inlining, and the request-count collapse the feature exists for — all share
// one fixture builder.
import { beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { serveStatic, type ServeStaticOptions } from './static-server.js';
import { clearBundleCaches } from './app-bundle.js';

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

function mockReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, rel);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
}

function newDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'centraid-app-bundle-'));
  writeTree(dir, files);
  return dir;
}

/** Shared-assets dir with minimal working stand-ins for the real kit set. */
function newSharedDir(): string {
  return newDir({
    // Side effects (globalThis writes) keep esbuild's tree shaking from
    // dropping these stand-ins the way it would drop genuinely dead code.
    'react-core.min.js':
      'export const jsx = (t, p) => ({ t, p });\n' +
      'export const jsxs = jsx;\n' +
      "export const Fragment = 'frag';\n" +
      'export const createRoot = () => ({ render() {} });\n' +
      'globalThis.__REACT_CORE_COPIES = (globalThis.__REACT_CORE_COPIES ?? 0) + 1;\n',
    'jsx-runtime.js': "export { Fragment, jsx, jsxs } from './react-core.min.js';\n",
    'elements.js': "globalThis.__ELEMENTS = 'shared-elements';\n",
    'kit.js': "import './elements.js';\nexport const KIT = 'shared-kit';\n",
    'kit.css': '.kit-btn { color: teal; }\n',
    'tokens.css': ':root { --tok: 1; }\n',
    'wall.css': 'body { background: linen; }\n',
  });
}

/** A small multi-level app exercising every resolution rule at once. */
function newApp(): string {
  return newDir({
    'index.html': [
      '<!doctype html><html><head>',
      '<link rel="stylesheet" href="wall.css" />',
      '<link rel="stylesheet" href="tokens.css" />',
      '<link rel="stylesheet" href="app.css" />',
      '<link rel="stylesheet" href="kit.css" />',
      '</head><body><div id="root"></div>',
      '<script type="module" src="./app.jsx"></script>',
      '</body></html>',
    ].join('\n'),
    'app.css': '#root { display: grid; }',
    'app.jsx': [
      "import { KIT } from './kit.js';",
      "import { createRoot } from './react-core.min.js';",
      "import { label } from './util.js';",
      "import { Widget } from './components/Widget.jsx';",
      "export const APP_MARKER = 'app:' + KIT + ':' + label;",
      'globalThis.__APP = APP_MARKER;',
      'createRoot().render(<Widget />);',
    ].join('\n'),
    'util.js': "export const label = 'util-label';",
    'components/Widget.jsx': [
      "import { deep } from './nested/deep.js';",
      'export function Widget() {',
      '  return <span>{deep}</span>;',
      '}',
    ].join('\n'),
    'components/nested/deep.js': "export const deep = 'deep-marker';",
  });
}

async function serve(
  dir: string,
  rel: string,
  opts: ServeStaticOptions = {},
  headers: Record<string, string> = {},
): Promise<MockRes> {
  const { res, data } = mockRes();
  await serveStatic(mockReq(headers), res, dir, rel, opts);
  return data;
}

const BUNDLE_URL_RE = /_bundle\.([0-9a-f]{16})\.js/;

beforeEach(() => clearBundleCaches());

describe('live index.html — bundle rewrite + CSS inlining', () => {
  it('rewrites the module entry to a hashed bundle URL and inlines every stylesheet', async () => {
    const app = newApp();
    const shared = newSharedDir();
    const data = await serve(app, 'index.html', { sharedAssetsDir: shared });
    const html = data.body.toString('utf8');

    const m = BUNDLE_URL_RE.exec(html);
    expect(m, 'entry <script> was not rewritten to a bundle URL').toBeTruthy();
    expect(html).toContain(`src="./_bundle.${m![1]}.js"`);
    expect(html).not.toContain('src="./app.jsx"');

    // All four links collapsed into one <style> block, contents present,
    // per-app app.css and shared kit/tokens/wall all resolved.
    expect(html).not.toContain('<link rel="stylesheet"');
    const styleBlocks = html.match(/<style data-centraid-inlined-css>/g) ?? [];
    expect(styleBlocks.length).toBe(1);
    for (const marker of ['display: grid', 'color: teal', '--tok: 1', 'background: linen']) {
      expect(html).toContain(marker);
    }
    // Inline order preserves the link order (wall → tokens → app → kit).
    expect(html.indexOf('background: linen')).toBeLessThan(html.indexOf('--tok: 1'));
    expect(html.indexOf('--tok: 1')).toBeLessThan(html.indexOf('display: grid'));
  });

  it('leaves the entry untouched when the bundle build fails (broken import)', async () => {
    const app = newDir({
      'index.html':
        '<html><head></head><body><script type="module" src="./app.js"></script></body></html>',
      'app.js': "import { nope } from './missing.js'; void nope;",
    });
    const data = await serve(app, 'index.html', { sharedAssetsDir: newSharedDir() });
    const html = data.body.toString('utf8');
    expect(html).toContain('src="./app.js"');
    expect(html).not.toMatch(BUNDLE_URL_RE);
  });

  it('leaves a stylesheet as a link when its content cannot be inlined safely', async () => {
    const app = newDir({
      'index.html':
        '<html><head><link rel="stylesheet" href="a.css" /><link rel="stylesheet" href="b.css" /></head><body></body></html>',
      'a.css': '.a { color: red; }',
      'b.css': '.b { content: "</style>"; }',
    });
    const data = await serve(app, 'index.html');
    const html = data.body.toString('utf8');
    expect(html).toContain('color: red'); // a.css inlined
    expect(html).not.toContain('href="a.css"');
    expect(html).toContain('href="b.css"'); // b.css kept as a link
  });
});

describe('bundle serving — ETag, immutability, 304', () => {
  it('serves the bundle with a sha256 ETag, immutable cache-control, and honors If-None-Match', async () => {
    const app = newApp();
    const shared = newSharedDir();
    const html = (await serve(app, 'index.html', { sharedAssetsDir: shared })).body.toString();
    const hash = BUNDLE_URL_RE.exec(html)![1]!;

    const data = await serve(app, `_bundle.${hash}.js`, { sharedAssetsDir: shared });
    expect(data.statusCode).toBe(200);
    expect(data.headers['Content-Type']).toContain('application/javascript');
    expect(data.headers['Cache-Control']).toBe('private, max-age=31536000, immutable');

    const body = data.body.toString('utf8');
    // The whole graph is in one response: app, util, nested component, and
    // the shared kit/elements pulled through the root-level fallback.
    for (const marker of ['app:', 'util-label', 'deep-marker', 'shared-kit', 'shared-elements']) {
      expect(body).toContain(marker);
    }

    const expectedEtag = `"${createHash('sha256').update(data.body).digest('hex')}"`;
    expect(data.headers['ETag']).toBe(expectedEtag);
    expect(hash).toBe(expectedEtag.slice(1, 17));

    const revalidated = await serve(
      app,
      `_bundle.${hash}.js`,
      { sharedAssetsDir: shared },
      { 'if-none-match': expectedEtag },
    );
    expect(revalidated.statusCode).toBe(304);
    expect(revalidated.body.length).toBe(0);
  });

  it('bundles JSX through the automatic runtime with a single shared React instance', async () => {
    const app = newApp();
    const shared = newSharedDir();
    const html = (await serve(app, 'index.html', { sharedAssetsDir: shared })).body.toString();
    const hash = BUNDLE_URL_RE.exec(html)![1]!;
    const body = (
      await serve(app, `_bundle.${hash}.js`, { sharedAssetsDir: shared })
    ).body.toString('utf8');

    // No unresolved automatic-runtime import survives into the bundle…
    expect(body).not.toMatch(/from\s*["'][^"']*jsx-runtime/);
    // …and react-core's module body appears exactly once (one React copy),
    // even though app.jsx and components/Widget.jsx both need the runtime.
    const copies = body.match(/__REACT_CORE_COPIES = \(/g) ?? [];
    expect(copies.length).toBe(1);
  });

  it('prefers a per-app override over the shared copy, same as per-file serving', async () => {
    const app = newApp();
    const shared = newSharedDir();
    writeTree(app, { 'kit.js': "export const KIT = 'app-own-kit';" });
    const html = (await serve(app, 'index.html', { sharedAssetsDir: shared })).body.toString();
    const hash = BUNDLE_URL_RE.exec(html)![1]!;
    const body = (
      await serve(app, `_bundle.${hash}.js`, { sharedAssetsDir: shared })
    ).body.toString('utf8');
    expect(body).toContain('app-own-kit');
    expect(body).not.toContain('shared-kit');
  });

  it('404s an unknown bundle hash', async () => {
    const app = newApp();
    const data = await serve(app, '_bundle.0123456789abcdef.js', {
      sharedAssetsDir: newSharedDir(),
    });
    expect(data.statusCode).toBe(404);
  });
});

describe('invalidation — an app file edit re-keys the bundle', () => {
  it('serves a new hash after a nested file changes and 404s the old one', async () => {
    const app = newApp();
    const shared = newSharedDir();
    const opts = { sharedAssetsDir: shared };

    const first = (await serve(app, 'index.html', opts)).body.toString();
    const hash1 = BUNDLE_URL_RE.exec(first)![1]!;

    const edited = join(app, 'components/nested/deep.js');
    writeFileSync(edited, "export const deep = 'deep-marker-EDITED';");
    // Guarantee a visible mtime change even on coarse-mtime filesystems.
    const future = Date.now() / 1000 + 5;
    utimesSync(edited, future, future);

    const second = (await serve(app, 'index.html', opts)).body.toString();
    const hash2 = BUNDLE_URL_RE.exec(second)![1]!;
    expect(hash2).not.toBe(hash1);

    const fresh = await serve(app, `_bundle.${hash2}.js`, opts);
    expect(fresh.statusCode).toBe(200);
    expect(fresh.body.toString('utf8')).toContain('deep-marker-EDITED');

    const stale = await serve(app, `_bundle.${hash1}.js`, opts);
    expect(stale.statusCode).toBe(404);
  });
});

describe('draft serving stays per-file', () => {
  const draft = { draft: { appId: 'demo', sessionId: 'sess-1' } };

  it('does not rewrite draft HTML (script + stylesheet links untouched)', async () => {
    const app = newApp();
    const data = await serve(app, 'index.html', { ...draft, sharedAssetsDir: newSharedDir() });
    const html = data.body.toString('utf8');
    expect(html).toContain('src="./app.jsx"');
    expect(html).not.toMatch(BUNDLE_URL_RE);
    expect(html).toContain('<link rel="stylesheet" href="app.css" />');
  });

  it('404s a bundle-shaped rel under a draft instead of serving a bundle', async () => {
    const app = newApp();
    const shared = newSharedDir();
    // Warm the live cache so a bundle for this app definitely exists…
    const html = (await serve(app, 'index.html', { sharedAssetsDir: shared })).body.toString();
    const hash = BUNDLE_URL_RE.exec(html)![1]!;
    // …then ask for it through the draft path.
    const data = await serve(app, `_bundle.${hash}.js`, { ...draft, sharedAssetsDir: shared });
    expect(data.statusCode).toBe(404);
  });
});

/**
 * Count the requests a browser would make to boot the app: serve the HTML,
 * collect its script/link URLs, then walk every served JS file's static
 * imports transitively. Each successfully served URL counts once.
 */
async function countBootRequests(
  appDir: string,
  opts: ServeStaticOptions,
  htmlOpts: ServeStaticOptions = opts,
): Promise<number> {
  const seen = new Set<string>(['index.html']);
  const htmlRes = await serve(appDir, 'index.html', htmlOpts);
  expect(htmlRes.statusCode).toBe(200);
  const html = htmlRes.body.toString('utf8');

  const queue: string[] = [];
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*"([^"]+)"/gi)) queue.push(m[1]!);
  for (const m of html.matchAll(/<link\b[^>]*rel\s*=\s*"stylesheet"[^>]*href\s*=\s*"([^"]+)"/gi)) {
    queue.push(m[1]!);
  }

  const resolveRel = (fromRel: string, spec: string): string => {
    const baseDir = fromRel.includes('/') ? fromRel.slice(0, fromRel.lastIndexOf('/')) : '';
    return path.posix.normalize(path.posix.join(baseDir, spec));
  };

  const pending = queue.map((u) => resolveRel('index.html', u.replace(/^\.\//, '')));
  while (pending.length > 0) {
    const rel = pending.pop()!;
    if (seen.has(rel)) continue;
    const data = await serve(appDir, rel, opts);
    if (data.statusCode !== 200) continue;
    seen.add(rel);
    if (!/\.(js|jsx|mjs)$/.test(rel)) continue;
    const body = data.body.toString('utf8');
    for (const m of body.matchAll(/(?:import|export)[^'"]*from\s*["']([^"']+)["']/g)) {
      pending.push(resolveRel(rel, m[1]!));
    }
    for (const m of body.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g)) {
      pending.push(resolveRel(rel, m[1]!));
    }
  }
  return seen.size;
}

describe('request count over a served app', () => {
  it('collapses the synthetic app to 2 requests (HTML + bundle)', async () => {
    const app = newApp();
    const shared = newSharedDir();
    const opts = { sharedAssetsDir: shared };
    const draftOpts = { ...opts, draft: { appId: 'demo', sessionId: 's' } };

    // Per-file baseline, i.e. exactly what a draft (or the pre-#404 server)
    // serves: html + 4 css + app.jsx + util.js + Widget.jsx + deep.js +
    // kit.js + elements.js + jsx-runtime.js + react-core.min.js = 13.
    const before = await countBootRequests(app, opts, draftOpts);
    expect(before).toBe(13);

    const after = await countBootRequests(app, opts);
    expect(after).toBe(2);
  });

  const photosDir = path.resolve(import.meta.dirname, '../../../blueprints/apps/photos');
  const kitDir = path.resolve(import.meta.dirname, '../../../blueprints/kit');
  it.skipIf(!existsSync(photosDir) || !existsSync(kitDir))(
    'collapses the real photos app to 2 requests (HTML + bundle)',
    async () => {
      const opts = { sharedAssetsDir: kitDir };
      const draftOpts = { ...opts, draft: { appId: 'photos', sessionId: 's' } };

      const before = await countBootRequests(photosDir, opts, draftOpts);
      const after = await countBootRequests(photosDir, opts);
      // Ground truth from the #404 audit: ~30+ requests per open. Bounded,
      // not exact, so blueprint-side refactors don't break this suite.
      expect(before).toBeGreaterThanOrEqual(30);
      expect(after).toBe(2);

      // The real bundle must be syntactically valid ESM — parse it (esbuild
      // throws on a syntax error). Running it needs a DOM, which the boot
      // gate covers per-file; this at least proves the whole-graph output
      // is a loadable module.
      const html = (await serve(photosDir, 'index.html', opts)).body.toString('utf8');
      const hash = BUNDLE_URL_RE.exec(html)![1]!;
      const bundle = (await serve(photosDir, `_bundle.${hash}.js`, opts)).body.toString('utf8');
      const esbuild = await import('esbuild');
      await expect(esbuild.transform(bundle, { loader: 'js' })).resolves.toBeTruthy();
      // eslint-disable-next-line no-console -- benchmark evidence is intentional (#408)
      console.info(`photos boot requests: before(per-file)=${before} after(bundled)=${after}`);
    },
  );
});
