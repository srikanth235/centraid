import { promises as fs } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as esbuild from 'esbuild';
import { contentTypeFor, resolveStaticPath, staticSecurityHeaders } from './security.js';
import { sendError } from './http-utils.js';

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
 */
const SHARED_ASSET_FILES = new Set([
  'kit.js',
  'kit.css',
  'elements.js',
  'react-core.min.js',
  'jsx-runtime.js',
  'tokens.css',
  'wall.css',
]);

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
 * Transform a `.jsx` source file to plain JS via esbuild's `automatic` JSX
 * runtime, with an mtime-and-depth-keyed cache (see {@link jsxCache}). On a
 * transform failure (normal mid-edit for a builder agent), returns a
 * 200-able JS body that logs the esbuild error to the console instead of
 * throwing — a broken `.jsx` file must not 500 the whole preview iframe, and
 * there's no existing "friendly broken preview" precedent elsewhere in this
 * codebase to follow, so this keeps the iframe alive and puts the error
 * where a builder agent's own tooling (devtools) can see it.
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
      loader: 'jsx',
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
function computeEtag(buf: Buffer): string {
  return `"${createHash('sha256').update(buf).digest('hex')}"`;
}

/**
 * Does the request's `If-None-Match` header cover `etag`? Handles `*`
 * (matches anything) and the comma-separated multi-value form. Our etags
 * never contain commas or quotes, so a plain split+trim parse is correct —
 * no need for a real structured-header parser. Node also folds repeated
 * `If-None-Match` headers into one comma-joined string, which this covers.
 */
function ifNoneMatchHits(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const trimmed = header.trim();
  if (trimmed === '*') return true;
  return trimmed.split(',').some((tok) => tok.trim() === etag);
}

/**
 * Settings to bake into the served HTML's `<html>` tag. Two parallel maps:
 *
 *   - `dataAttrs` becomes `<html data-<key>="<value>">`. Used for theme,
 *     density, accent-key, card variant, anything driven by CSS attribute
 *     selectors.
 *   - `cssVars` becomes inline `style="--<key>:<value>"` on the same tag.
 *     Used for `--bg-l`, `--accent`, anything that drives variables.
 *
 * Keys and values are validated before injection — see the regexes below.
 * Anything that fails validation is silently dropped rather than escaped,
 * because the server is the only writer and the renderer is the only
 * reader. Garbage in HTML attributes is a much worse failure mode than
 * an attribute simply not appearing.
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
   * usual `location.pathname` sniff would mis-read it) and routes its tool
   * calls at `/centraid/_draft/<sessionId>/_tool/` so the draft's handlers
   * run. The `_changes` subscription stays relative — it resolves to the
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
}

export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  appDir: string,
  rel: string,
  opts: ServeStaticOptions = {},
): Promise<true> {
  let file = resolveStaticPath(appDir, rel);
  if (!file) return sendError(res, 404, 'not_found', 'Asset not found.');

  let buf: Buffer;
  try {
    buf = await fs.readFile(file);
  } catch {
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
    try {
      buf = await fs.readFile(shared);
      file = shared;
    } catch {
      return sendError(res, 404, 'not_found', 'Asset not found.');
    }
  }

  // Builder-generated apps may ship `app.jsx` source directly — the git code
  // store stays source-only (no persisted build artifacts), so the compile
  // to plain JS happens transparently at serve time, per-request, cached by
  // mtime (see {@link transformJsx}). Applies identically to the live
  // `/centraid/<id>/...` path and the draft `/centraid/_draft/<sid>/<id>/...`
  // path — both funnel through this same `serveStatic` call. The transform
  // also hands back its etag, memoized in {@link jsxCache} alongside the
  // code, so it isn't re-hashed per request.
  let jsxEtag: string | undefined;
  if (file.endsWith('.jsx')) {
    const transformed = await transformJsx(file, buf, rel);
    buf = Buffer.from(transformed.code, 'utf8');
    jsxEtag = transformed.etag;
  }

  const contentType = contentTypeFor(file);
  // For HTML responses we mint a per-response CSP nonce, stamp it onto every
  // inline `<script>` tag in the served document, and forward it to the
  // security headers so `script-src` accepts those tagged inline scripts.
  // Without this the inline live-settings bridge baked into each app's
  // `index.html` would be blocked by the default `script-src 'self'`. The
  // nonce is fresh per response so a leaked old nonce can't whitelist a
  // future injection.
  let inlineScriptNonce: string | undefined;
  if (contentType.startsWith('text/html')) {
    let html = buf.toString('utf8');
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
            toolUrl: `/centraid/_draft/${encodeURIComponent(opts.draft.sessionId)}/_tool/`,
          }
        : undefined,
    );
    inlineScriptNonce = randomBytes(16).toString('base64');
    html = stampInlineScriptNonces(html, inlineScriptNonce);
    buf = Buffer.from(html, 'utf8');

    // No ETag, no conditional handling: the document embeds a fresh
    // per-response CSP nonce and serve-time-baked settings (theme, prefs,
    // draft wiring), so no two responses are ever byte-identical — a
    // validator would never hit. `no-store`, not `no-cache`: nothing here is
    // worth revalidating against, so the browser shouldn't keep a copy at all.
    res.statusCode = 200;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    for (const [k, v] of Object.entries(staticSecurityHeaders({ inlineScriptNonce }))) {
      res.setHeader(k, v);
    }
    res.end(buf);
    return true;
  }

  // Non-HTML assets: content-validated revalidation, not time-based
  // freshness. `no-cache` (still cacheable — just always revalidate first)
  // rather than `max-age`/`immutable`, because the same URL's bytes DO
  // change under this gateway: reinstall/republish swaps the code-store
  // worktree a file resolves from, and a draft file is mutated live by the
  // builder while the preview iframe keeps polling the same path. An etag
  // match turns a repeat request into a 304 with no body — same
  // zero-transfer win as long-lived caching, minus the staleness risk.
  // `private`: per-gateway, bearer-auth'd responses, never a shared/CDN cache.
  const etag = jsxEtag ?? computeEtag(buf);
  const ifNoneMatch = req.headers['if-none-match'];
  const notModified = ifNoneMatchHits(
    Array.isArray(ifNoneMatch) ? ifNoneMatch.join(',') : ifNoneMatch,
    etag,
  );

  res.statusCode = notModified ? 304 : 200;
  res.setHeader('Content-Type', contentType);
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'private, no-cache');
  for (const [k, v] of Object.entries(staticSecurityHeaders({ inlineScriptNonce }))) {
    res.setHeader(k, v);
  }
  res.end(notModified ? Buffer.alloc(0) : buf);
  return true;
}

/**
 * Inline `<script>` that wires the runtime's `_changes` SSE stream into the
 * page as both a `CustomEvent('centraid:datachange')` and a sugar API:
 *
 *     window.centraid.onChange(refresh)   // returns an unsubscribe fn
 *     window.addEventListener('centraid:datachange', e => …)   // vanilla
 *
 * Auto-injected into every served HTML right after `<head>` so it runs
 * before user `<script>`s parse. The CSP nonce stamper (which runs after
 * this) tags the tag so `script-src 'self'` accepts it. The script also
 * augments — never overwrites — `window.centraid`, so the mobile bridge's
 * `centraid.haptic` / `centraid.notify` namespace coexists.
 *
 * Reconnect: EventSource auto-reconnects on transient drops; we additionally
 * re-open after 5s if it lands in CLOSED (`readyState === 2`) so the iframe
 * recovers from gateway restarts without a page reload.
 */
// Inline bridge baked into every served HTML. Two responsibilities:
//
// 1. **Change feed.** Subscribes to `_changes` SSE and exposes
//    `window.centraid.onChange(cb)` + the `centraid:datachange` event.
//
// 2. **Three-tool helpers.** Issue #107 removed the per-handler
//    `_run` / `_data/<name>` routes; in their place is one shim at
//    `/centraid/_tool/<toolName>`. To keep templates terse we inject
//    `window.centraid.write({action,input})`, `.read({query,input})`,
//    and `.describe(filter?)`. They derive the app id from
//    `location.pathname` (`/centraid/<id>/...`) so the bridge is
//    portable across apps without per-app code-gen.
function changeBridgeScript(draft?: { appId: string; toolUrl: string }): string {
  // Live mode sniffs the app id from `/centraid/<id>/…` and posts tools at
  // `/centraid/_tool/`. Draft mode pins both: the path's first segment is
  // `_draft`, so the sniff would mis-read it, and tool calls must hit the
  // draft shim so the session worktree's handlers run.
  const idAndTool = draft
    ? `var appId=${JSON.stringify(draft.appId)};w.centraid.appId=appId;var toolUrl=${JSON.stringify(draft.toolUrl)};`
    : `var m=/^\\/centraid\\/([^/]+)\\//.exec(w.location.pathname);var appId=m?decodeURIComponent(m[1]):null;w.centraid.appId=appId;var toolUrl='/centraid/_tool/';`;
  return `<script>(function(){var w=window;w.centraid=w.centraid||{};var listeners=new Set();w.centraid.onChange=function(cb){if(typeof cb!=='function')return function(){};listeners.add(cb);return function(){listeners.delete(cb);};};${idAndTool}function callTool(name,body){return fetch(toolUrl+name,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.text().then(function(t){var j=null;try{j=t?JSON.parse(t):null;}catch(_){}if(!r.ok){var err=j&&j.message?j.message:('tool '+name+' failed: '+r.status);var e=new Error(err);e.code=j&&j.code;e.status=r.status;throw e;}return j;});});}w.centraid.write=function(opts){if(!opts||!opts.action)return Promise.reject(new Error('write requires {action}'));return callTool('centraid_write',{app:appId,action:opts.action,input:opts.input});};w.centraid.read=function(opts){if(!opts||!opts.query)return Promise.reject(new Error('read requires {query}'));return callTool('centraid_read',{app:appId,query:opts.query,input:opts.input});};w.centraid.describe=function(filter){var body=Object.assign({},filter||{});if(!body.app&&appId)body.app=appId;return callTool('centraid_describe',body);};if(typeof EventSource!=='function')return;var es;function connect(){try{es=new EventSource('_changes');}catch(_){return;}es.addEventListener('change',function(ev){var d;try{d=JSON.parse(ev.data);}catch(_){d={tables:[],ts:Date.now()};}try{w.dispatchEvent(new CustomEvent('centraid:datachange',{detail:d}));}catch(_){}listeners.forEach(function(cb){try{cb(d);}catch(_){}});});es.addEventListener('error',function(){if(es&&es.readyState===2){setTimeout(function(){if(es&&es.readyState===2){try{es.close();}catch(_){}connect();}},5000);}});}connect();})();</script>`;
}

function injectChangeBridge(html: string, draft?: { appId: string; toolUrl: string }): string {
  // Inject right after the opening <head>. If the document has no <head>
  // (rare in practice but legal HTML) the script falls through unchanged
  // — better to leave the doc intact than guess where to splice.
  const m = /<head\b[^>]*>/i.exec(html);
  if (!m) return html;
  const insertAt = m.index + m[0].length;
  return html.slice(0, insertAt) + changeBridgeScript(draft) + html.slice(insertAt);
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
