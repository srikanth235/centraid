import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { staticSecurityHeaders } from './security.js';
import {
  compress,
  isCompressibleType,
  MIN_COMPRESS_BYTES,
  negotiateEncoding,
  STATIC_QUALITY,
  type CompressQuality,
  type Encoding,
} from './compression.js';

export function computeEtag(buf: Buffer): string {
  return `"${createHash('sha256').update(buf).digest('hex')}"`;
}

/**
 * Does the request's `If-None-Match` header cover `etag`? Handles `*`
 * (matches anything) and the comma-separated multi-value form. Our etags
 * never contain commas or quotes, so a plain split+trim parse is correct —
 * no need for a real structured-header parser. Node also folds repeated
 * `If-None-Match` headers into one comma-joined string, which this covers.
 */
export function ifNoneMatchHits(header: string | undefined, etag: string): boolean {
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
/** Per-(path,mtime,size) etag + compressed-variant cache for plain assets. */
interface PlainCacheEntry {
  etag: string;
  /** Raw bytes, kept from the miss that populated the entry. */
  raw?: Buffer;
  variants: Map<Encoding, Buffer>;
}
export const plainCache = new Map<string, PlainCacheEntry>();

/** Compressed variants for a transformed `.jsx` body, keyed by its content etag. */
export const jsxVariantCache = new Map<string, Map<Encoding, Buffer>>();
export function variantCacheFor(
  cache: Map<string, Map<Encoding, Buffer>>,
  etag: string,
): Map<Encoding, Buffer> {
  let m = cache.get(etag);
  if (!m) {
    m = new Map();
    cache.set(etag, m);
  }
  return m;
}

/**
 * Finish a cacheable non-HTML asset response: conditional 304 (no body read),
 * else content-negotiated compression drawn from / filled into `variants`.
 *
 * Default `no-cache` (still cacheable — just always revalidate first) rather
 * than `max-age`/`immutable`, because the same URL's bytes DO change under
 * this gateway: reinstall/republish swaps the code-store worktree a file
 * resolves from, and a draft file is mutated live by the builder while the
 * preview iframe keeps polling the same path. An etag match turns a repeat
 * request into a 304 with no body. `private`: per-gateway, bearer-auth'd
 * responses, never a shared/CDN cache.
 *
 * `cacheControl` overrides that default for the one asset family whose URL
 * embeds its own content hash (the `_bundle.<hash>.js` whole-app bundle, see
 * app-bundle.ts) — those are genuinely immutable: a content change changes
 * the URL, so `max-age`/`immutable` is safe and lets warm opens skip the
 * revalidation round-trip entirely.
 */
export async function finishStaticAsset(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    contentType: string;
    etag: string;
    rawSize: number;
    loadRaw: () => Buffer | Promise<Buffer>;
    variants: Map<Encoding, Buffer>;
    cacheControl?: string;
  },
): Promise<true> {
  const { contentType, etag, rawSize, loadRaw, variants } = opts;
  const ifNoneMatch = req.headers['if-none-match'];
  const notModified = ifNoneMatchHits(
    Array.isArray(ifNoneMatch) ? ifNoneMatch.join(',') : ifNoneMatch,
    etag,
  );

  res.setHeader('Content-Type', contentType);
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', opts.cacheControl ?? 'private, no-cache');
  // Content negotiation applies to compressible types → caches must key on
  // Accept-Encoding even when this particular response wasn't compressed.
  if (isCompressibleType(contentType)) res.setHeader('Vary', 'Accept-Encoding');
  for (const [k, v] of Object.entries(staticSecurityHeaders({}))) {
    res.setHeader(k, v);
  }

  if (notModified) {
    res.statusCode = 304;
    res.end(Buffer.alloc(0));
    return true;
  }

  const encoding =
    rawSize >= MIN_COMPRESS_BYTES && isCompressibleType(contentType)
      ? negotiateEncoding(req.headers['accept-encoding'])
      : null;
  res.statusCode = 200;
  if (!encoding) {
    res.end(await loadRaw());
    return true;
  }
  let variant = variants.get(encoding);
  if (!variant) {
    variant = compress(await loadRaw(), encoding, STATIC_QUALITY);
    variants.set(encoding, variant);
  }
  res.setHeader('Content-Encoding', encoding);
  res.end(variant);
  return true;
}

/**
 * Write `raw` to `res`, compressing inline when the client offers it and the
 * body is worth it. For uncached, per-response bodies (the HTML shell) — no
 * variant cache; the caller has already set every other header.
 */
export function writeCompressible(
  req: IncomingMessage,
  res: ServerResponse,
  raw: Buffer,
  contentType: string,
  quality: CompressQuality,
): void {
  if (isCompressibleType(contentType)) res.setHeader('Vary', 'Accept-Encoding');
  const encoding =
    raw.length >= MIN_COMPRESS_BYTES && isCompressibleType(contentType)
      ? negotiateEncoding(req.headers['accept-encoding'])
      : null;
  if (!encoding) {
    res.end(raw);
    return;
  }
  res.setHeader('Content-Encoding', encoding);
  res.end(compress(raw, encoding, quality));
}
