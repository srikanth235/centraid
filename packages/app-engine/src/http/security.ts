import path from 'node:path';

const STATIC_EXT_ALLOWLIST = new Set([
  '.html',
  '.htm',
  '.css',
  '.js',
  '.jsx',
  '.mjs',
  '.json',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.map',
]);

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.jsx': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json; charset=utf-8',
};

/** Files whose names are reserved and never served as static.
 *
 * `app.json` is intentionally *not* reserved — the desktop's per-app
 * settings popover fetches it to read the manifest's `knobs` array
 * (folded in from the old `app-knobs.json` sidecar). The manifest is the
 * agent-facing tool contract; nothing in it is secret. */
const RESERVED_FILENAMES = new Set(['data.sqlite', '_registry.json']);

/** Directories whose contents are never served as static. */
const RESERVED_DIRS = new Set(['queries', 'actions']);

/** Apps whose ids start with `_` are reserved for plugin internals. */
export function isReservedAppId(id: string): boolean {
  return id.startsWith('_') || id === '' || id.includes('/') || id.includes('..');
}

/**
 * Resolve a requested file path inside an app folder, or return null if
 * the request escapes the folder, lands on a reserved name, or has an
 * extension outside the allowlist.
 */
export function resolveStaticPath(appDir: string, relRequest: string): string | null {
  // Strip leading slash, normalize.
  const rel = relRequest.replace(/^\/+/, '');
  if (rel === '' || rel === '/') {
    return path.join(appDir, 'index.html');
  }

  const resolved = path.resolve(appDir, rel);
  const expectedPrefix = appDir.endsWith(path.sep) ? appDir : appDir + path.sep;
  if (!resolved.startsWith(expectedPrefix)) return null;

  const segments = path.relative(appDir, resolved).split(path.sep);
  const first = segments[0];
  if (first && RESERVED_DIRS.has(first)) return null;
  const last = segments[segments.length - 1] ?? '';
  if (RESERVED_FILENAMES.has(last)) return null;

  const ext = path.extname(resolved).toLowerCase();
  if (!STATIC_EXT_ALLOWLIST.has(ext)) return null;

  return resolved;
}

export function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * Per-response security headers for static asset delivery.
 *
 * Same-origin only. Inline scripts are blocked by default (`script-src 'self'`).
 * For HTML responses where the runtime needs to allow specific inline scripts
 * (e.g. the live-settings bridge baked into each app's `index.html`), pass
 * `inlineScriptNonce` — `script-src` then accepts the same-origin sources
 * plus any `<script>` tag carrying `nonce="<nonce>"`. `static-server` mints
 * the nonce per response and stamps it onto every inline `<script>` it emits,
 * so the runtime never needs to know which specific scripts an app contains.
 */
export function staticSecurityHeaders(
  opts: { inlineScriptNonce?: string; frameAncestor?: string } = {},
  frameAncestor = opts.frameAncestor,
): Record<string, string> {
  const scriptSrc = opts.inlineScriptNonce ? `'self' 'nonce-${opts.inlineScriptNonce}'` : "'self'";
  const frameAncestors = frameAncestor ? `'self' ${frameAncestor}` : "'self'";
  return {
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': `default-src 'self'; script-src ${scriptSrc}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors ${frameAncestors}`,
    'Referrer-Policy': 'no-referrer',
  };
}

/** Constant-time comparison for bearer tokens. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
