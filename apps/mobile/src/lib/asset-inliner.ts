// Fetches an app's index.html plus its referenced <link rel="stylesheet">
// and <script src="…"> targets with the bearer header attached, and splices
// the asset contents back into the document as inline <style>/<script> tags.
//
// Why: WKWebView's `source.headers` only attaches headers to the initial
// document GET — sub-resource loads (the page's own <script src>, <link href>)
// don't inherit them. Without auth on those loads, the gateway returns 401
// and the page's JS never runs, so event handlers never bind and form
// submissions fall through to the WebView, triggering "HTTP 401" errors.
//
// Once the WebView is loaded via { html, baseUrl }, the page's own runtime
// fetch() calls (e.g. `_data/list`, `_run`) are intercepted by the injected
// bridge shim, which proxies them through native with the bearer attached.

import { appLiveUrl, authHeader } from './gateway';

export interface InlinedDocument {
  html: string;
  /** Used as the WebView's baseUrl so relative URLs resolve against the gateway. */
  baseUrl: string;
}

/** Resolve a possibly-relative URL against the document's URL. */
function resolveAgainst(base: string, ref: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref) || ref.startsWith('data:')) return ref;
  // base ends with '/' (the document URL) — strip filename if not.
  const slash = base.lastIndexOf('/');
  const dir = slash >= 0 ? base.slice(0, slash + 1) : `${base}/`;
  if (ref.startsWith('/')) {
    const originMatch = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)/i.exec(base);
    return originMatch ? `${originMatch[1]}${ref}` : ref;
  }
  return `${dir}${ref}`;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { method: 'GET', headers: authHeader() });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

/** Read the value of an HTML attribute from a tag string. Quotes optional. */
function attr(tag: string, name: string): string | undefined {
  const re = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

/** Escape `</script>` inside a JS payload that's going inside <script>...</script>. */
function escapeScriptBody(js: string): string {
  return js.replace(/<\/script/gi, '<\\/script');
}

async function inlineStylesheets(html: string, docUrl: string): Promise<string> {
  // <link ... rel="stylesheet" ... href="..." ... /?>
  // `\b` lives inside the bare-word alternative only; quoted forms land
  // on a `"` (non-word), so a trailing `\b` would always fail there.
  const re = /<link\b[^>]*\brel\s*=\s*(?:"stylesheet"|'stylesheet'|stylesheet\b)[^>]*>/gi;
  const matches = [...html.matchAll(re)];
  if (matches.length === 0) return html;
  const replacements = await Promise.all(
    matches.map(async (m) => {
      const tag = m[0];
      const href = attr(tag, 'href');
      if (!href) return { tag, replacement: tag };
      try {
        const css = await fetchText(resolveAgainst(docUrl, href));
        return { tag, replacement: `<style>\n${css}\n</style>` };
      } catch (err) {
        return {
          tag,
          replacement: `<!-- inline-css failed for ${href}: ${
            err instanceof Error ? err.message : String(err)
          } -->`,
        };
      }
    }),
  );
  let out = html;
  for (const { tag, replacement } of replacements) {
    out = out.replace(tag, replacement);
  }
  return out;
}

async function inlineScripts(html: string, docUrl: string): Promise<string> {
  // <script ... src="..." ... ></script>  (only with src — leave inline scripts alone)
  const re = /<script\b[^>]*\bsrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>\s*<\/script>/gi;
  const matches = [...html.matchAll(re)];
  if (matches.length === 0) return html;
  const replacements = await Promise.all(
    matches.map(async (m) => {
      const tag = m[0];
      const src = attr(tag, 'src');
      if (!src) return { tag, replacement: tag };
      const type = attr(tag, 'type');
      const typeAttr = type ? ` type="${type}"` : '';
      try {
        const js = await fetchText(resolveAgainst(docUrl, src));
        return { tag, replacement: `<script${typeAttr}>\n${escapeScriptBody(js)}\n</script>` };
      } catch (err) {
        return {
          tag,
          replacement: `<!-- inline-js failed for ${src}: ${
            err instanceof Error ? err.message : String(err)
          } -->`,
        };
      }
    }),
  );
  let out = html;
  for (const { tag, replacement } of replacements) {
    out = out.replace(tag, replacement);
  }
  return out;
}

/** Fetch + rewrite an app's document so the WebView can render it offline of auth. */
export async function fetchInlinedAppDocument(appId: string): Promise<InlinedDocument> {
  const docUrl = appLiveUrl(appId);
  const html = await fetchText(docUrl);
  const withCss = await inlineStylesheets(html, docUrl);
  const withJs = await inlineScripts(withCss, docUrl);
  return { html: withJs, baseUrl: docUrl };
}
