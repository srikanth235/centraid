import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { contentTypeFor, resolveStaticPath, staticSecurityHeaders } from './security.js';
import { sendError } from './http-utils.js';

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
}

export async function serveStatic(
  res: ServerResponse,
  appDir: string,
  rel: string,
  opts: ServeStaticOptions = {},
): Promise<true> {
  const file = resolveStaticPath(appDir, rel);
  if (!file) return sendError(res, 404, 'not_found', 'Asset not found.');

  let buf: Buffer;
  try {
    buf = await fs.readFile(file);
  } catch {
    return sendError(res, 404, 'not_found', 'Asset not found.');
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
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', contentType);
  for (const [k, v] of Object.entries(staticSecurityHeaders({ inlineScriptNonce }))) {
    res.setHeader(k, v);
  }
  res.end(buf);
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
