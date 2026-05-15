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
    if (opts.settingsInject) {
      buf = Buffer.from(injectSettings(buf.toString('utf8'), opts.settingsInject), 'utf8');
    }
    inlineScriptNonce = randomBytes(16).toString('base64');
    buf = Buffer.from(stampInlineScriptNonces(buf.toString('utf8'), inlineScriptNonce), 'utf8');
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
