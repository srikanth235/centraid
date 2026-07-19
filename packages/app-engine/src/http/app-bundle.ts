/*
 * Whole-graph app bundling at the serving seam (issue #404, "Serving
 * structure").
 *
 * A blueprint app at rest is a raw per-file ESM graph — `index.html` loads
 * `app.jsx`, which imports 3–4 levels of siblings (photos: 58 JS files / 100
 * import edges). Served per-file, every module is its own request revalidated
 * per boot, and on the PWA every request crosses an iroh relay. This module
 * collapses the graph server-side:
 *
 *   - When a LIVE (non-draft) `index.html` is served, {@link
 *     prepareBundledIndex} rewrites each root-level `<script type="module"
 *     src="…">` entry to a content-hashed bundle URL (`./_bundle.<hash>.js`)
 *     and inlines every root-level `<link rel="stylesheet">`'s contents into
 *     one `<style>` block (the app CSP already carries `style-src
 *     'unsafe-inline'`, and no app/kit CSS uses `url()`/`@import`, so
 *     inlining is base-URL-safe). One HTML request paints with zero
 *     render-blocking asset fetches; the whole JS graph is one more request.
 *
 *   - The bundle itself is built by esbuild (`bundle: true`), resolving
 *     imports through the SAME rules the per-file server applies: a relative
 *     specifier resolves inside the app dir (via `resolveStaticPath`, so the
 *     escape/reserved/extension guards hold), with the root-only
 *     {@link SHARED_ASSET_FILES} fallback to `sharedAssetsDir` when the app
 *     carries no copy of its own — per-app override wins, exactly as over
 *     HTTP. `.jsx`/`.tsx`/`.ts` sources go through the same `automatic` JSX
 *     runtime as the per-file transform (esbuild auto-detects the loader by
 *     extension); the emitted `./jsx-runtime` import resolves to the app's (or
 *     shared) `jsx-runtime.js`, so React identity is preserved. A
 *     `*.module.css` import is compiled to a JS module in an `onLoad` hook
 *     (css-module.ts, same helper the per-file server uses) so the graph stays
 *     JS-only and the single-output-file invariant holds.
 *
 *   - Because the URL embeds the content hash, the bundle is served
 *     `max-age=31536000, immutable` (+ a sha256 ETag for the PWA service
 *     worker's URL+ETag cache): a warm open never revalidates it. Content
 *     changes change the hash; `index.html` is `no-store`, so the browser
 *     always refetches it and picks up the new bundle URL. A request for a
 *     hash we no longer hold 404s cleanly (the client re-fetches HTML on
 *     reload).
 *
 *   - DRAFT serving (`/centraid/_draft/…`, the builder's live-edit preview)
 *     is deliberately untouched: the builder edits files one at a time and
 *     the preview must reflect each save, so drafts keep the per-file path
 *     (and `_bundle.*.js` 404s there — no file by that name exists).
 *
 *   - Bundling is best-effort: if esbuild fails (broken source, an import
 *     shape it can't follow), the entry `<script>` tag is left as-is and the
 *     app serves per-file exactly as before. The failure is cached against
 *     the file-tree manifest so a hot reload loop doesn't re-run a doomed
 *     build per request.
 *
 * Cache shape: one entry per app dir, keyed by a manifest of the app's
 * JS/JSX file tree (rel path + mtime + size for every file outside the
 * reserved handler dirs) plus the shared JS assets' stats — an edit,
 * add, or delete anywhere in the graph's search space invalidates. Bundles
 * are content-addressed by sha256; the serve path looks a hash up without
 * a freshness check (equal hash ⇒ identical bytes), and stale hashes fall
 * out when the manifest changes and the entry is rebuilt.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { resolveStaticPath, SHARED_ASSET_FILES } from './security.js';
import { compileCssModule } from './css-module.js';
import { computeEtag } from './asset-variants.js';
import { compress, staticQualityForHost, type Encoding } from './compression.js';

/**
 * Served rel path of a whole-app bundle: `_bundle.<16-hex>.js`. The leading
 * underscore + embedded hash make a collision with a real app file
 * practically impossible, and the live serve path intercepts this shape
 * before filesystem resolution, so a real file by this name could never
 * shadow it anyway.
 */
export const BUNDLE_REL_RE = /^_bundle\.([0-9a-f]{16})\.js$/;

/** Directories never part of the browser graph (mirror of the serving guards
 * — `queries`/`actions` are RESERVED_DIRS in security.ts, never served;
 * `automations` is node-side handler code the page can't import). */
const NON_GRAPH_DIRS = new Set(['queries', 'actions', 'automations', 'node_modules']);

export interface BuiltBundle {
  ok: true;
  /** First 16 hex chars of the sha256 — embedded in the served URL. */
  hash: string;
  /** Quoted full sha256 of the bundle bytes (same convention as computeEtag). */
  etag: string;
  code: Buffer;
  /** Compressed-variant cache, filled lazily by finishStaticAsset. */
  variants: Map<Encoding, Buffer>;
}
type BundleResult = BuiltBundle | { ok: false; error: string };

interface AppBundleCacheEntry {
  manifest: string;
  /** Keyed by entry rel path (`app.jsx`, `app.js`, …). */
  bundles: Map<string, BundleResult>;
}

/** Keyed by resolved app dir. Bounded: a gateway serves a bounded set of
 * installed apps (same rationale as the jsxCache in static-server.ts). */
const bundleCache = new Map<string, AppBundleCacheEntry>();

/** In-flight build dedup — two concurrent index requests for the same app
 * share one esbuild run instead of racing duplicates. */
const inflight = new Map<string, Promise<BundleResult>>();

/** Test hook: drop all cached bundles (fresh state per test). */
export function clearBundleCaches(): void {
  bundleCache.clear();
  inflight.clear();
}

async function statOrNull(file: string): Promise<import('node:fs').Stats | null> {
  try {
    return await fs.stat(file);
  } catch {
    return null;
  }
}

/**
 * Manifest of everything that can influence a bundle's output: every
 * `.js`/`.jsx`/`.ts`/`.tsx` file under the app dir (excluding non-graph dirs),
 * plus every `*.module.css` (a CSS module is compiled into the JS graph — see
 * buildBundle's onLoad — so its bytes affect the bundle and MUST invalidate
 * it), plus the shared JS assets the root-only fallback can pull in.
 * `rel\0mtime\0size` lines, sorted — any edit/add/delete changes the string.
 * Plain (non-module) CSS and `index.html` are deliberately NOT included: plain
 * CSS is inlined fresh per HTML response and the HTML itself is read per
 * request, so neither needs to invalidate the JS bundle.
 */
async function computeManifest(appDir: string, sharedAssetsDir?: string): Promise<string> {
  const lines: string[] = [];
  async function walk(rel: string): Promise<void> {
    const entries = await fs.readdir(path.join(appDir, rel), { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!NON_GRAPH_DIRS.has(e.name)) await walk(r);
      } else if (
        r.endsWith('.js') ||
        r.endsWith('.jsx') ||
        r.endsWith('.ts') ||
        r.endsWith('.tsx') ||
        r.endsWith('.module.css')
      ) {
        const st = await statOrNull(path.join(appDir, r));
        if (st) lines.push(`${r}\0${st.mtimeMs}\0${st.size}`);
      }
    }
  }
  await walk('');
  if (sharedAssetsDir) {
    for (const f of [...SHARED_ASSET_FILES].sort()) {
      if (!f.endsWith('.js')) continue;
      const st = await statOrNull(path.join(sharedAssetsDir, f));
      lines.push(`\0shared:${f}\0${st ? `${st.mtimeMs}\0${st.size}` : 'absent'}`);
    }
  }
  return lines.sort().join('\n');
}

/**
 * esbuild resolver that mirrors the per-file server's resolution exactly:
 *
 *   1. Only relative specifiers — apps import siblings by relative URL over
 *      HTTP, so a bare specifier has no meaning here and fails the build
 *      (which falls back to per-file serving, where it would fail in the
 *      browser too).
 *   2. A file imported FROM the shared dir (kit.js → `./elements.js`,
 *      jsx-runtime.js → `./react-core.min.js`) resolves as if the importer
 *      lived at the app root — that's where its URL serves from, so the
 *      app's own copy must win exactly as it does over HTTP.
 *   3. In-app targets go through `resolveStaticPath` (escape, reserved
 *      names/dirs, extension allowlist — a bundle must not be able to inline
 *      what the server would never serve).
 *   4. Missing root-level targets whose basename is in SHARED_ASSET_FILES
 *      fall back to the shared dir — root-level only, same as serveStatic.
 *   5. The `automatic` JSX runtime's emitted `./jsx-runtime` (extensionless,
 *      importer-relative) maps to the root-level `jsx-runtime.js`, matching
 *      the depth-aware specifier rewrite of the per-file transform.
 */
function appGraphPlugin(root: string, sharedRoot: string | null): esbuild.Plugin {
  return {
    name: 'centraid-app-graph',
    setup(build) {
      // A `*.module.css` in the graph is compiled to a JS module (style
      // injector + class-map default export, css-module.ts) BEFORE esbuild
      // sees it, so the whole graph stays JS-only. This is load-bearing for
      // the single-output invariant below: `buildBundle` takes
      // `result.outputFiles[0]`, and a raw `default` CSS import would make
      // esbuild emit a SECOND (CSS) output that then gets silently dropped.
      // Same shared helper as the per-file server, so the two paths compile a
      // module identically. The `<link>`-inlining of GLOBAL css (index.html)
      // is unaffected — those files never enter the JS graph.
      build.onLoad({ filter: /\.module\.css$/ }, async (args) => {
        const compiled = await compileCssModule(args.path, root);
        return { contents: compiled.js, loader: 'js', resolveDir: path.dirname(args.path) };
      });

      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.kind === 'entry-point') return null;
        const spec = args.path;

        // The importing file's *served* directory: shared-dir files serve at
        // the app root, everything else serves where it lives.
        const servedDir =
          sharedRoot &&
          (args.resolveDir === sharedRoot || args.resolveDir.startsWith(sharedRoot + path.sep))
            ? root
            : args.resolveDir;

        // esbuild's automatic runtime emits `./jsx-runtime` (no extension).
        // Root-level file, app copy first — same as the per-file rewrite.
        if (spec === './jsx-runtime' || spec.endsWith('/jsx-runtime')) {
          const own = path.join(root, 'jsx-runtime.js');
          if (await statOrNull(own)) return { path: own };
          if (sharedRoot) {
            const shared = path.join(sharedRoot, 'jsx-runtime.js');
            if (await statOrNull(shared)) return { path: shared };
          }
          return { errors: [{ text: `jsx-runtime.js not found for "${spec}"` }] };
        }

        if (!spec.startsWith('./') && !spec.startsWith('../')) {
          return { errors: [{ text: `bare import "${spec}" is not servable from an app dir` }] };
        }

        const target = path.resolve(servedDir, spec);
        const rel = path.relative(root, target);
        // Same guards as serving: inside the app dir, not reserved, allowed
        // extension. resolveStaticPath returns null for any violation.
        const resolved = rel.startsWith('..') ? null : resolveStaticPath(root, rel);
        if (resolved && (await statOrNull(resolved))) return { path: resolved };

        // Root-only shared fallback, mirroring serveStatic.
        const base = path.basename(target);
        const isRootLevel = path.dirname(target) === root;
        if (isRootLevel && sharedRoot && SHARED_ASSET_FILES.has(base)) {
          const shared = path.join(sharedRoot, base);
          if (await statOrNull(shared)) return { path: shared };
        }
        return {
          errors: [
            { text: `cannot resolve "${spec}" from ${path.relative(root, servedDir) || '.'}` },
          ],
        };
      });
    },
  };
}

async function buildBundle(
  appDir: string,
  entryRel: string,
  sharedAssetsDir?: string,
): Promise<BundleResult> {
  try {
    // esbuild reports importers' `resolveDir` as REALPATHS — a symlinked app
    // dir (macOS `/var` → `/private/var`, code-store worktree symlinks) would
    // otherwise fail the containment guard for every import. Resolve both
    // roots to their real locations before the build so path prefixes agree.
    const root = await fs.realpath(appDir);
    const sharedRoot = sharedAssetsDir
      ? await fs.realpath(sharedAssetsDir).catch(() => null)
      : null;
    const result = await esbuild.build({
      entryPoints: [path.join(root, entryRel)],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      // Same JSX config as the per-file transformJsx — automatic runtime,
      // resolved by the plugin above to the one shared React instance.
      jsx: 'automatic',
      jsxImportSource: '.',
      // Not minified: react-core.min.js (the bulk) is pre-minified, wire
      // size is handled by the compression layer, and source maps are out
      // of scope — an unminified bundle stays debuggable without them.
      minify: false,
      // Keeps esbuild's per-module path comments app-relative instead of
      // leaking the gateway's absolute worktree layout into served code.
      absWorkingDir: root,
      logLevel: 'silent',
      plugins: [appGraphPlugin(root, sharedRoot)],
    });
    const out = result.outputFiles?.[0];
    if (!out) return { ok: false, error: 'esbuild produced no output' };
    const code = Buffer.from(out.contents);
    const etag = computeEtag(code);
    const hash = etag.slice(1, 17); // first 16 hex of the sha256, sans quote
    return { ok: true, hash, etag, code, variants: new Map() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Bundle (or return the cached bundle for) an app's entry module. Returns
 * `null` when the build fails — the caller leaves the HTML untouched and the
 * app serves per-file, exactly as before this module existed.
 */
export async function bundleForEntry(
  appDir: string,
  entryRel: string,
  sharedAssetsDir?: string,
): Promise<BuiltBundle | null> {
  const dirKey = path.resolve(appDir);
  const manifest = await computeManifest(dirKey, sharedAssetsDir).catch(() => null);
  if (manifest === null) return null;

  let entry = bundleCache.get(dirKey);
  if (!entry || entry.manifest !== manifest) {
    entry = { manifest, bundles: new Map() };
    bundleCache.set(dirKey, entry);
  }
  const cached = entry.bundles.get(entryRel);
  if (cached) return cached.ok ? cached : null;

  const flightKey = `${dirKey}\0${entryRel}\0${manifest}`;
  let pending = inflight.get(flightKey);
  if (!pending) {
    pending = buildBundle(dirKey, entryRel, sharedAssetsDir).finally(() =>
      inflight.delete(flightKey),
    );
    inflight.set(flightKey, pending);
  }
  const result = await pending;
  // The cache entry may have been superseded by a concurrent manifest change;
  // only record against the entry that matches the manifest we built from.
  const current = bundleCache.get(dirKey);
  if (current && current.manifest === manifest) current.bundles.set(entryRel, result);
  return result.ok ? result : null;
}

/**
 * Content-addressed lookup for the serve path. No freshness check: an equal
 * hash means identical bytes, so serving a cached hit is always correct
 * (that's what makes `immutable` safe). Unknown hash → null → 404; the
 * `no-store` HTML always carries the current hash, so a live page can only
 * hold a stale hash across a redeploy, where a clean 404 (→ reload) beats
 * silently serving mixed versions.
 */
export function findBundleByHash(appDir: string, hash: string): BuiltBundle | null {
  const entry = bundleCache.get(path.resolve(appDir));
  if (!entry) return null;
  for (const b of entry.bundles.values()) {
    if (b.ok && b.hash === hash) return b;
  }
  return null;
}

/**
 * Publish/install hook: build every HTML entry and both wire variants before
 * a human can request the app. The same cache is used by the serve path, so
 * neither esbuild nor brotli lands on first paint.
 */
export async function prewarmAppAssets(
  appDir: string,
  sharedAssetsDir?: string,
): Promise<{ bundles: number; variants: number }> {
  const html = await fs.readFile(path.join(appDir, 'index.html'), 'utf8');
  const prepared = await prepareBundledIndex(html, appDir, sharedAssetsDir);
  const hashes = new Set(
    [...prepared.matchAll(/_bundle\.([0-9a-f]{16})\.js/g)].map((match) => match[1]!),
  );
  let variants = 0;
  for (const hash of hashes) {
    const bundle = findBundleByHash(appDir, hash);
    if (!bundle) continue;
    const quality = staticQualityForHost();
    const [br, gzip] = await Promise.all([
      compress(bundle.code, 'br', quality),
      compress(bundle.code, 'gzip', quality),
    ]);
    bundle.variants.set('br', br);
    bundle.variants.set('gzip', gzip);
    variants += 2;
  }
  return { bundles: hashes.size, variants };
}

// --- index.html rewriting ---------------------------------------------------

const SCRIPT_TAG_RE = /<script\b[^>]*>/gi;
const LINK_TAG_RE = /<link\b[^>]*>/gi;

function attrOf(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? (m[2] ?? m[3] ?? '') : null;
}

/** Root-level relative URL (`x.css`, `./app.jsx`) → bare filename, else null. */
function rootLevelRel(url: string | null): string | null {
  if (!url) return null;
  if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(url) || url.startsWith('/')) return null;
  const stripped = url.replace(/^\.\//, '');
  if (stripped.includes('/') || stripped.includes('?') || stripped.includes('#')) return null;
  return stripped;
}

/**
 * Rewrite a LIVE app's `index.html` for bundled serving:
 *
 *   (a) each root-level `<script type="module" src="…">` entry is pointed at
 *       its content-hashed whole-graph bundle (built/cached here, so the
 *       bundle is already warm when the browser requests it);
 *   (b) every root-level `<link rel="stylesheet">` that resolves (app dir
 *       first, shared fallback for the SHARED_ASSET_FILES names) is inlined,
 *       in order, into a single `<style>` block replacing the first link —
 *       zero render-blocking CSS requests. A file containing `</style` is
 *       left as a link (cannot be inlined safely); so is one that doesn't
 *       resolve (it 404s either way).
 *
 * Everything is best-effort per tag: any entry whose bundle fails keeps its
 * original per-file `<script>`. No `modulepreload` hints are added because
 * a successful rewrite leaves no external module to preload.
 */
export async function prepareBundledIndex(
  html: string,
  appDir: string,
  sharedAssetsDir?: string,
): Promise<string> {
  let out = html;

  // (a) entry scripts → bundles.
  const scripts = [...out.matchAll(SCRIPT_TAG_RE)];
  for (const m of scripts) {
    const tag = m[0];
    const type = attrOf(tag, 'type');
    if (!type || type.toLowerCase() !== 'module') continue;
    const src = attrOf(tag, 'src');
    const entryRel = rootLevelRel(src);
    if (!entryRel || !/\.(js|jsx|ts|tsx|mjs)$/i.test(entryRel)) continue;
    const bundle = await bundleForEntry(appDir, entryRel, sharedAssetsDir);
    if (!bundle) continue;
    const rewritten = tag.replace(src!, `./_bundle.${bundle.hash}.js`);
    out = out.replace(tag, rewritten);
  }

  // (b) stylesheet links → one inline <style>.
  const links = [...out.matchAll(LINK_TAG_RE)];
  const inlined: { tag: string; css: string }[] = [];
  for (const m of links) {
    const tag = m[0];
    const relAttr = attrOf(tag, 'rel');
    if (!relAttr || relAttr.toLowerCase() !== 'stylesheet') continue;
    const name = rootLevelRel(attrOf(tag, 'href'));
    if (!name || !name.endsWith('.css')) continue;
    let file = resolveStaticPath(appDir, name);
    if (!file || !(await statOrNull(file))) {
      const shared =
        sharedAssetsDir && SHARED_ASSET_FILES.has(name)
          ? resolveStaticPath(sharedAssetsDir, name)
          : null;
      file = shared && (await statOrNull(shared)) ? shared : null;
    }
    if (!file) continue;
    const css = (await fs.readFile(file)).toString('utf8');
    if (/<\/style/i.test(css)) continue;
    inlined.push({ tag, css: `/* inlined: ${name} */\n${css}` });
  }
  if (inlined.length > 0) {
    const block = `<style data-centraid-inlined-css>\n${inlined
      .map((x) => x.css)
      .join('\n')}\n</style>`;
    out = out.replace(inlined[0]!.tag, block);
    for (const { tag } of inlined.slice(1)) out = out.replace(tag, '');
  }
  return out;
}
