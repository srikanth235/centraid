import { promises as fs } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { contentTypeFor, resolveStaticPath, staticSecurityHeaders } from './security.js';
import { sendError } from './http-utils.js';

export interface ServeStaticOptions {
  /**
   * Theme + bg-l values from the iframe URL's query string. When serving
   * `index.html`, these are baked into the `<html>` element server-side so the
   * iframe paints in the correct theme even if `theme-bridge.js` is missing
   * (legacy apps) or fails to run before first paint.
   */
  themeInject?: { theme?: string; bgL?: string };
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
  if (contentType.startsWith('text/html') && opts.themeInject) {
    buf = Buffer.from(injectTheme(buf.toString('utf8'), opts.themeInject), 'utf8');
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', contentType);
  for (const [k, v] of Object.entries(staticSecurityHeaders())) {
    res.setHeader(k, v);
  }
  res.end(buf);
  return true;
}

/**
 * Rewrite the first `<html ...>` tag to carry `data-theme` and an inline
 * `--bg-l` style. Existing attributes are preserved. If the tag already has
 * `data-theme`, we leave it (the app explicitly set one). If there's no
 * `<html>` tag at all, we leave the document untouched.
 */
function injectTheme(html: string, vals: { theme?: string; bgL?: string }): string {
  const theme = vals.theme === 'light' || vals.theme === 'dark' ? vals.theme : undefined;
  const bgL = vals.bgL && /^\d+(\.\d+)?$/.test(vals.bgL) ? vals.bgL : undefined;
  if (!theme && !bgL) return html;
  return html.replace(/<html\b([^>]*)>/i, (_match, attrs: string) => {
    let out = attrs;
    if (theme && !/\bdata-theme\s*=/i.test(out)) {
      out += ` data-theme="${theme}"`;
    }
    if (bgL) {
      if (/\bstyle\s*=\s*"/i.test(out)) {
        out = out.replace(
          /\bstyle\s*=\s*"([^"]*)"/i,
          (_m, body: string) => `style="${body};--bg-l:${bgL}%"`,
        );
      } else {
        out += ` style="--bg-l:${bgL}%"`;
      }
    }
    return `<html${out}>`;
  });
}
