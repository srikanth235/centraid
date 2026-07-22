// governance: allow-repo-hygiene file-size-limit cohesive per-file static asset server; the .ts/.tsx transform, .module.css compile branch, and range/etag plumbing are one request path and share the cache/mtime helpers
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as esbuild from 'esbuild';
import {
  contentTypeFor,
  isCssModuleFile,
  resolveStaticPath,
  SHARED_ASSET_FILES,
  staticSecurityHeaders,
} from './security.js';
import { BUNDLE_REL_RE, findBundleByHash, prepareBundledIndex } from './app-bundle.js';
import { compileCssModule } from './css-module.js';
import { sendError } from './http-utils.js';
import { DYNAMIC_QUALITY } from './compression.js';
import {
  computeEtag,
  cssModuleVariantCache,
  finishStaticAsset,
  jsxVariantCache,
  plainCache,
  variantCacheFor,
  writeCompressible,
} from './asset-variants.js';
import { injectChangeBridge } from './bridge-script.js';

/**
 * Assets that are shared verbatim by every app and therefore served from a
 * single canonical dir (`sharedAssetsDir`) instead of a per-app copy. An app
 * folder no longer ships `kit.js` / `kit.css`; the request still comes in as
 * the app-relative `/centraid/<id>/kit.js` (index.html `<link>` and app.js's
 * `import './kit.js'` are unchanged), and `serveStatic` falls back to the
 * shared dir when the app folder has no copy of its own. An app *may* still
 * ship its own file to override — the per-app copy wins.
 *
 * This fallback only ever applies to a **root-level** request (`rel` has no
 * directory component — see the guard in `serveStatic`). Every legitimate
 * reference to one of these files resolves to a root-level URL: `index.html`
 * links them relative to the app root, and a nested `components/*.jsx` file
 * either climbs back to the root itself (`import './kit.js'` from `app.jsx`,
 * `import '../kit.js'` from `components/X.jsx` — hand-written by the app) or,
 * for the one specifier esbuild emits automatically, via the depth-aware
 * `jsx-runtime` rewrite in {@link transformJsx}. A *nested* request for one of
 * these names (e.g. `components/react-core.min.js`) therefore has no
 * legitimate source and 404s instead of being silently served — a future
 * depth-rewrite bug should fail loudly, not get masked by this fallback.
 *
 * `kit.js` imports `elements.js` (the kit's native Web Components, issue #327
 * — dependency-free vanilla custom elements, no runtime import of their own).
 * It's a relative same-origin ESM import resolved the same way as `kit.js`,
 * so it must fall back to the shared dir too.
 *
 * `react-core.min.js` (vendored runtime-only React bundle) and
 * `jsx-runtime.js` (the `automatic` JSX runtime esbuild's transform imports,
 * see {@link transformJsx}) round out the set for builder-generated `.jsx`
 * apps that don't ship their own copies.
 *
 * `tokens.css` (the generated blueprint-app token layer, see
 * packages/blueprints/scripts/vendor-tokens.mjs) and `wall.css` (the shared
 * "wall" surface gradient, copied verbatim from packages/design-tokens) are
 * shared the same way — an app with its own `wall.css` (e.g. people, for its
 * warm-blush light-mode override) still wins via the per-app-copy precedence
 * above.
 *
 * The set itself is defined in security.ts (the leaf module) so the
 * whole-graph bundler (app-bundle.ts) resolves through the SAME list as this
 * per-file server without an import cycle. This comment stays here because
 * the serving semantics it documents live here.
 */

/**
 * Per-file JSX transform cache, keyed by the absolute resolved file path
 * *and* the climb depth the transform was rewritten for (see
 * {@link jsxRuntimeClimb}) — `${file}\0${depth}`. A given file is only ever
 * requested at one depth in practice (its depth is fixed by where it lives
 * under the app root), but keying on depth too means a mismatched depth can
 * never serve another depth's cached rewrite, even if some future caller
 * violates that assumption. Unbounded: a gateway serves a bounded set of
 * installed apps (each app folder has a small, fixed number of `.jsx`
 * files), so there's no need for eviction — this isn't a general-purpose
 * cache serving arbitrary input.
 *
 * `ok: false` entries cache a *failed* transform (syntactically broken JSX
 * mid-generation is normal for a builder agent writing files incrementally)
 * against the file's current `mtimeMs`, so a hot preview-reload loop doesn't
 * re-run esbuild on every request for a file that hasn't changed — it only
 * re-transforms once the mtime moves.
 *
 * `etag` is the content hash of `code` (or the error shim body for a failed
 * transform), computed once alongside the transform rather than per request
 * — see {@link computeEtag}. Keying it off the same mtime-validated cache
 * entry means an edit (mtime bump) naturally produces a fresh etag, whether
 * the edit fixes a broken file or changes an already-working one.
 */
type JsxCacheEntry = { mtimeMs: number; etag: string } & (
  | { ok: true; code: string }
  | { ok: false; error: string }
);
const jsxCache = new Map<string, JsxCacheEntry>();

/**
 * Per-file compiled-CSS-module cache, keyed by absolute path and validated by
 * `mtimeMs` — the same mtime-invalidation shape as {@link jsxCache}. A
 * `*.module.css` request is served as a JS module (style injector + class-map
 * default export, see css-module.ts); the compiled body and its content etag
 * are memoized here so an unchanged module isn't re-run through esbuild per
 * request. Bounded for the same reason as jsxCache (a gateway serves a fixed
 * set of installed apps). Unlike jsxCache this doesn't cache failures: a CSS
 * module that fails to compile is a hard 500 (there's no "friendly broken
 * preview" story for a stylesheet the way there is for mid-edit JSX).
 */
type CssModuleCacheEntry = { mtimeMs: number; code: string; etag: string };
const cssModuleCache = new Map<string, CssModuleCacheEntry>();

// esbuild's `automatic` JSX runtime emits an extensionless relative import —
// `import { jsx as _jsx } from "./jsx-runtime";` — resolved relative to the
// IMPORTING FILE's own directory, same as any other relative ESM specifier.
// Browsers can't resolve it as-is (no bare-specifier/extension-less
// resolution over HTTP), so it's rewritten below. `jsx-runtime.js` itself is
// only ever served from the app root (or the shared dir standing in for it —
// see {@link SHARED_ASSET_FILES}), so a file nested under subdirectories
// needs a specifier that *climbs back up* to the root, not just `./` — a
// bare `.js` suffix would make `components/Grid.jsx` request
// `components/jsx-runtime.js`, one directory too deep. esbuild always emits
// double quotes, but a single-quoted form costs nothing extra to also
// handle.
const JSX_RUNTIME_SPECIFIER_RE = /(["'])\.\/jsx-runtime\1/g;

/**
 * The relative-path prefix that climbs from a served file's directory back
 * to the app root, derived from the request path `rel` (e.g.
 * `components/Grid.jsx`, or `app.jsx` at the root) — NOT from the resolved
 * absolute file path, because it's the URL the browser resolves the rewritten
 * import against, not the filesystem layout. Depth 0 (root) → `./`; depth 1
 * (one directory down) → `../`; depth 2 → `../../`; and so on.
 */
function jsxRuntimeClimb(rel: string): { depth: number; prefix: string } {
  const segments = rel
    .replace(/^\.?\/+/, '')
    .split('/')
    .filter(Boolean);
  const depth = Math.max(0, segments.length - 1);
  return { depth, prefix: depth === 0 ? './' : '../'.repeat(depth) };
}

/**
 * The esbuild loader for a source file the browser imports as JS, selected by
 * extension: `.jsx`→`jsx`, `.tsx`→`tsx`, `.ts`→`ts`. TypeScript sources
 * (issue: TS-authored apps) are stripped/compiled the same serve-time way the
 * `.jsx` path already compiles React dialect — the `automatic` JSX config and
 * the depth-aware `./jsx-runtime` rewrite apply unchanged to `.tsx` and are
 * inert for `.ts` (no JSX to rewrite).
 */
function loaderForExt(file: string): 'jsx' | 'tsx' | 'ts' {
  if (file.endsWith('.tsx')) return 'tsx';
  if (file.endsWith('.ts')) return 'ts';
  return 'jsx';
}

/**
 * Transform a `.jsx`/`.tsx`/`.ts` source file to plain JS via esbuild's
 * `automatic` JSX runtime, with an mtime-and-depth-keyed cache (see
 * {@link jsxCache}). On a transform failure (normal mid-edit for a builder
 * agent), returns a 200-able JS body that logs the esbuild error to the
 * console instead of throwing — a broken source file must not 500 the whole
 * preview iframe, and there's no existing "friendly broken preview" precedent
 * elsewhere in this codebase to follow, so this keeps the iframe alive and
 * puts the error where a builder agent's own tooling (devtools) can see it.
 *
 * Returns the body alongside its content etag, computed once here and cached
 * with the transform (not re-hashed per request) — the mtime key that
 * invalidates the transform on edit invalidates the etag with it too.
 */
async function transformJsx(
  file: string,
  source: Buffer,
  rel: string,
): Promise<{ code: string; etag: string }> {
  const { depth, prefix } = jsxRuntimeClimb(rel);
  const cacheKey = `${file}\0${depth}`;
  const stat = await fs.stat(file);
  const cached = jsxCache.get(cacheKey);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    if (cached.ok) return { code: cached.code, etag: cached.etag };
    return { code: errorShim(cached.error), etag: cached.etag };
  }

  try {
    const result = await esbuild.transform(source.toString('utf8'), {
      loader: loaderForExt(file),
      jsx: 'automatic',
      jsxImportSource: '.',
    });
    const code = result.code.replace(JSX_RUNTIME_SPECIFIER_RE, `$1${prefix}jsx-runtime.js$1`);
    const etag = computeEtag(Buffer.from(code, 'utf8'));
    jsxCache.set(cacheKey, { mtimeMs: stat.mtimeMs, ok: true, code, etag });
    return { code, etag };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const shim = errorShim(message);
    const etag = computeEtag(Buffer.from(shim, 'utf8'));
    jsxCache.set(cacheKey, { mtimeMs: stat.mtimeMs, ok: false, error: message, etag });
    return { code: shim, etag };
  }
}

function errorShim(message: string): string {
  return `// JSX transform failed — see the logged error below.\nconsole.error(${JSON.stringify(message)});\n`;
}

/**
 * Strong content etag for a response body — sha256 hex, quoted per RFC 7232.
 * Not `W/`-prefixed (weak): hashed over the exact bytes sent, so equal etags
 * mean byte-identical bodies. Cheap enough to hash per request for plain
 * files (react-core.min.js, the largest vendored asset at ~313KB, hashes in
 * well under a millisecond) — no separate content cache needed; `.jsx`
 * responses get theirs memoized for free by riding along in {@link jsxCache}.
 */
export interface SettingsInject {
  dataAttrs?: Record<string, string>;
  cssVars?: Record<string, string>;
}

export interface ServeStaticOptions {
  /** Settings to bake into the `<html>` element of `index.html`. */
  settingsInject?: SettingsInject;
  /**
   * Draft-preview context (issue #141). When set, the served page is a
   * session worktree draft mounted under `/centraid/_draft/<sessionId>/
   * <appId>/`, NOT the live `/centraid/<appId>/`. The injected bridge then
   * pins `appId` explicitly (the path's first segment is `_draft`, so the
   * usual `location.pathname` sniff would mis-read it) and routes its app
   * RPC calls under `/centraid/_draft/<sessionId>/<appId>/` so the draft's
   * handlers run. The `_changes` subscription stays relative — it resolves to the
   * draft route's app-changes, which proxies the same live change bus.
   */
  draft?: { appId: string; sessionId: string };
  /**
   * Canonical dir holding assets shared verbatim across every app
   * (`kit.js` / `kit.css` — see {@link SHARED_ASSET_FILES}). When the app
   * folder has no copy of a requested shared asset, it is served from here.
   * Omit to disable the fallback (a missing file then 404s as usual).
   */
  sharedAssetsDir?: string;
  frameAncestor?: string;
}
export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  appDir: string,
  rel: string,
  opts: ServeStaticOptions = {},
): Promise<true> {
  // Whole-app bundle URLs (`_bundle.<hash>.js`, minted by the live
  // index.html rewrite below) are content-addressed and never touch the
  // filesystem — see app-bundle.ts. Live serving only: a draft never
  // references one (its HTML isn't rewritten), so under `_draft/` this
  // shape falls through to normal resolution and 404s loudly.
  const bundleMatch = opts.draft ? null : BUNDLE_REL_RE.exec(rel.replace(/^\.?\/+/, ''));
  if (bundleMatch) {
    const bundle = findBundleByHash(appDir, bundleMatch[1]!);
    if (!bundle) return sendError(res, 404, 'not_found', 'Unknown bundle hash.');
    return finishStaticAsset(req, res, {
      contentType: 'application/javascript; charset=utf-8',
      etag: bundle.etag,
      rawSize: bundle.code.length,
      loadRaw: () => bundle.code,
      variants: bundle.variants,
      // Safe because the URL embeds the content hash: new content = new URL.
      // The ETag still rides along for the PWA service worker's URL+ETag
      // asset cache.
      cacheControl: 'private, max-age=31536000, immutable',
    });
  }

  let file = resolveStaticPath(appDir, rel);
  if (!file) return sendError(res, 404, 'not_found', 'Asset not found.');

  // Stat first (not read): the file's `mtimeMs`+`size` key the etag/variant
  // cache below, and a 304 revalidation for an unchanged file must never
  // touch its bytes (issue #404 — a repeat load of a 313KB vendored bundle
  // shouldn't re-read+re-hash it). `stat` also stands in for the old
  // read+catch existence probe used by the shared-asset fallback.
  let stat = await statOrNull(file);
  if (!stat) {
    // Fall back to the shared canonical copy for whitelisted assets an app
    // folder doesn't carry itself (kit.js / kit.css). Resolved through
    // `resolveStaticPath` so the same escape/allowlist guards apply.
    //
    // Root-level requests only (`rel` has no directory component) — see the
    // doc comment on `SHARED_ASSET_FILES`. Every legitimate request for one
    // of these names is root-level; a nested one (e.g.
    // `components/react-core.min.js`) means the depth-aware `jsx-runtime`
    // rewrite (or a hand-written relative import) is wrong, and that must
    // 404 loudly instead of silently resolving to the shared copy.
    const isRootLevel = !rel.replace(/^\.?\/+/, '').includes('/');
    const base = path.basename(file);
    const shared =
      isRootLevel && opts.sharedAssetsDir && SHARED_ASSET_FILES.has(base)
        ? resolveStaticPath(opts.sharedAssetsDir, base)
        : null;
    if (!shared) return sendError(res, 404, 'not_found', 'Asset not found.');
    const sharedStat = await statOrNull(shared);
    if (!sharedStat) return sendError(res, 404, 'not_found', 'Asset not found.');
    file = shared;
    stat = sharedStat;
  }

  const contentType = contentTypeFor(file);

  // For HTML responses we mint a per-response CSP nonce, stamp it onto every
  // inline `<script>` tag in the served document, and forward it to the
  // security headers so `script-src` accepts those tagged inline scripts.
  // Without this the inline live-settings bridge baked into each app's
  // `index.html` would be blocked by the default `script-src 'self'`. The
  // nonce is fresh per response so a leaked old nonce can't whitelist a
  // future injection.
  if (contentType.startsWith('text/html')) {
    let html = (await fs.readFile(file)).toString('utf8');
    // LIVE serving collapses the app's request waterfall (issue #404): the
    // entry `<script type="module">` is rewritten to a content-hashed
    // whole-graph bundle and the render-blocking stylesheet `<link>`s are
    // inlined into one `<style>` block (CSP already carries `style-src
    // 'unsafe-inline'`). Best-effort — a failed bundle leaves the original
    // per-file tags in place. DRAFT previews are exempt: the builder edits
    // files one at a time and the preview must reflect each save without a
    // whole-graph rebuild getting in the way of file-level semantics.
    if (!opts.draft) {
      html = await prepareBundledIndex(html, appDir, opts.sharedAssetsDir);
    }
    if (opts.settingsInject) {
      html = injectSettings(html, opts.settingsInject);
    }
    // Bake the change-bus bridge into every served HTML — without this,
    // an app's iframe never observes mutations that happen behind its
    // back (chat-assistant writes, cross-window edits, future cron jobs).
    // The injected script subscribes to `/centraid/<id>/_changes` SSE and
    // re-broadcasts each event into the page as `centraid:datachange` +
    // `window.centraid.onChange(cb)`. Templates opt in with one line.
    html = injectChangeBridge(
      html,
      opts.draft
        ? {
            appId: opts.draft.appId,
            basePath: `/centraid/_draft/${encodeURIComponent(opts.draft.sessionId)}/${encodeURIComponent(opts.draft.appId)}/`,
          }
        : undefined,
    );
    const inlineScriptNonce = randomBytes(16).toString('base64');
    html = stampInlineScriptNonces(html, inlineScriptNonce);
    const raw = Buffer.from(html, 'utf8');

    // The fresh CSP nonce and baked settings make responses unique, so an ETag
    // cannot hit. `no-store` ensures browsers do not retain the document.
    // The doc shell is compressible (3-5x) — compress inline (no variant
    // cache; it's unique per response) with the fast dynamic quality.
    res.statusCode = 200;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    for (const [k, v] of Object.entries(
      staticSecurityHeaders({ inlineScriptNonce, frameAncestor: opts.frameAncestor }),
    )) {
      res.setHeader(k, v);
    }
    await writeCompressible(req, res, raw, contentType, DYNAMIC_QUALITY);
    return true;
  }

  // A `*.module.css` request is a browser `import` of a CSS module, so it
  // must leave here as JavaScript (style injector + class-map default export,
  // see css-module.ts) with `application/javascript` — NOT as text/css, which
  // is what `contentTypeFor`'s trailing-`.css` read would pick. A plain
  // (non-module) `.css` file falls through untouched to the text/css path
  // below. Compiled body + etag are memoized by mtime in {@link
  // cssModuleCache}; compressed variants ride the etag-keyed
  // {@link cssModuleVariantCache}. `appDir` is the compilation root so hashed
  // class names stay deterministic and path-prefix-free.
  if (isCssModuleFile(file)) {
    const stat = await fs.stat(file);
    let cachedCss = cssModuleCache.get(file);
    if (!cachedCss || cachedCss.mtimeMs !== stat.mtimeMs) {
      const compiled = await compileCssModule(file, appDir);
      cachedCss = { mtimeMs: stat.mtimeMs, code: compiled.js, etag: compiled.etag };
      cssModuleCache.set(file, cachedCss);
    }
    const raw = Buffer.from(cachedCss.code, 'utf8');
    return finishStaticAsset(req, res, {
      contentType: 'application/javascript; charset=utf-8',
      etag: cachedCss.etag,
      rawSize: raw.length,
      loadRaw: () => raw,
      variants: variantCacheFor(cssModuleVariantCache, cachedCss.etag),
    });
  }

  // Builder-generated apps may ship `app.jsx` source directly, and TS-authored
  // apps ship `app.tsx` / `.ts` siblings — the git code store stays
  // source-only (no persisted build artifacts), so the compile to plain JS
  // happens transparently at serve time, cached by mtime (see
  // {@link transformJsx}). Applies identically to the live `/centraid/<id>/…`
  // path and the draft `/centraid/_draft/<sid>/<id>/…` path — both funnel
  // through this same `serveStatic` call. The transform hands back its etag,
  // memoized in {@link jsxCache}, so it isn't re-hashed per request; its
  // compressed variants ride the etag-keyed {@link jsxVariantCache}.
  if (file.endsWith('.jsx') || file.endsWith('.tsx') || file.endsWith('.ts')) {
    const transformed = await transformJsx(file, await fs.readFile(file), rel);
    const raw = Buffer.from(transformed.code, 'utf8');
    return finishStaticAsset(req, res, {
      contentType,
      etag: transformed.etag,
      rawSize: raw.length,
      loadRaw: () => raw,
      variants: variantCacheFor(jsxVariantCache, transformed.etag),
    });
  }

  // Plain assets: etag memoized per (path, mtime, size) so a 304 skips the
  // read+hash, and compressed variants cached on the same entry so an
  // unchanged file is compressed at most once per encoding.
  const cacheKey = `${file}\0${stat.mtimeMs}\0${stat.size}`;
  let entry = plainCache.get(cacheKey);
  if (!entry) {
    const raw = await fs.readFile(file);
    entry = { etag: computeEtag(raw), raw, variants: new Map() };
    plainCache.set(cacheKey, entry);
  }
  return finishStaticAsset(req, res, {
    contentType,
    etag: entry.etag,
    rawSize: stat.size,
    // Raw bytes are retained on the cache entry (bounded app set — same
    // rationale as jsxCache), so neither a 304, an uncompressed hit, nor a
    // first compression ever re-reads an unchanged file. The `?? readFile`
    // is a belt-and-braces fallback that can't actually fire here.
    loadRaw: () => entry.raw ?? fs.readFile(file),
    variants: entry.variants,
  });
}

/** `fs.stat` or `null` when the path doesn't exist / isn't reachable. */
async function statOrNull(file: string): Promise<import('node:fs').Stats | null> {
  try {
    return await fs.stat(file);
  } catch {
    return null;
  }
}

/**
 * Add `nonce="<nonce>"` to every inline `<script>` tag (i.e. tags without a
 * `src` attribute). External-src `<script>` tags are left untouched — they're
 * already covered by `script-src 'self'`. Existing `nonce` attributes are
 * preserved (no double-stamping). Tags that contain a `>` inside an attribute
 * value would not parse correctly here; we accept that as a regex-parser
 * limitation since the runtime only serves HTML it controls.
 */
function stampInlineScriptNonces(html: string, nonce: string): string {
  return html.replace(/<script\b([^>]*)>/gi, (match, attrs: string) => {
    if (/\bsrc\s*=/i.test(attrs)) return match;
    if (/\bnonce\s*=/i.test(attrs)) return match;
    return `<script${attrs} nonce="${nonce}">`;
  });
}

// `data-<name>` attribute names: lowercase letters, digits, dashes only.
const DATA_KEY_RE = /^[a-z][a-z0-9-]*$/;
// CSS custom-property names (`--foo-bar`): lowercase letters, digits, dashes.
const CSS_KEY_RE = /^[a-z][a-z0-9-]*$/;
// Attribute values: forbid quotes, angle brackets, and control chars. A "%"
// suffix is fine, so the existing `--bg-l: 5%` use case still flows through.
const VALUE_RE = /^[A-Za-z0-9 #()%.,_/:-]+$/;

/**
 * Rewrite the first `<html ...>` tag to carry the provided data attrs and
 * CSS vars. Existing attributes are preserved. Per-key conflicts:
 *   - If `data-<key>` already exists on the tag, the existing value wins
 *     (the app explicitly set one). This mirrors the previous theme
 *     behavior — apps that hard-code a theme keep it.
 *   - CSS vars are appended to any existing `style=""`; if a var with the
 *     same name is already present, ours appends after it (CSS cascade
 *     gives the last one priority, which matches the desired behavior).
 *   - If there's no `<html>` tag at all, the document is left untouched.
 */
function injectSettings(html: string, vals: SettingsInject): string {
  const dataAttrs = filterStringMap(vals.dataAttrs ?? {}, DATA_KEY_RE);
  const cssVars = filterStringMap(vals.cssVars ?? {}, CSS_KEY_RE);
  const dataKeys = Object.keys(dataAttrs);
  const cssKeys = Object.keys(cssVars);
  if (dataKeys.length === 0 && cssKeys.length === 0) return html;

  return html.replace(/<html\b([^>]*)>/i, (_match, attrs: string) => {
    let out = attrs;

    for (const k of dataKeys) {
      const v = dataAttrs[k]!;
      const re = new RegExp(`\\bdata-${k}\\s*=`, 'i');
      if (!re.test(out)) {
        out += ` data-${k}="${v}"`;
      }
    }

    if (cssKeys.length > 0) {
      const inlineVars = cssKeys.map((k) => `--${k}:${cssVars[k]!}`).join(';');
      if (/\bstyle\s*=\s*"/i.test(out)) {
        out = out.replace(
          /\bstyle\s*=\s*"([^"]*)"/i,
          (_m, body: string) => `style="${body};${inlineVars}"`,
        );
      } else {
        out += ` style="${inlineVars}"`;
      }
    }

    return `<html${out}>`;
  });
}

/**
 * Drop entries whose key or value fails its validator. We keep the input
 * permissive (callers pass through user prefs / per-app settings without
 * pre-sanitizing) and quietly skip anything risky here.
 */
function filterStringMap(map: Record<string, string>, keyRe: RegExp): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    if (typeof v !== 'string') continue;
    if (!keyRe.test(k)) continue;
    if (!VALUE_RE.test(v)) continue;
    out[k] = v;
  }
  return out;
}
