// Blob custody routes (issue #296) — the two byte doors of the vault.
//
//   POST /centraid/_vault/blobs                       stage bytes (no receipt)
//        raw body (any non-JSON content type) with ?filename=&media_type=
//        &variant=&variant_of= — or JSON {base64, filename?, media_type?,
//        variant?, variant_of?} for parity with the import route.
//        → {sha256, mediaType, byteSize, existingContentId}
//        Staging is NOT a vault write: the command that claims the sha
//        (core.attach / core.add_document / media.add_asset with
//        staged_sha) is, and that is where the receipt mints.
//
//   GET  /centraid/_vault/blobs/<contentId>[?variant=thumb|preview]
//        consent-checked, DERIVED-reachability-gated byte serving:
//        Range (video scrubbing), ETag = sha256 (content-addressed ⇒
//        immutable caching), inline disposition — ?download=1 for saves.
//        Transport auth is the outer Bearer + vault scope (#289); the
//        desktop's auth-injector stamps both onto bare <img>/<video>
//        subresource loads, so app tiles need no token plumbing.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VaultBlobBackpressureError, VaultDiskFullError } from '@centraid/vault';
import type { RouteHandler } from '../serve/build-gateway.js';
import type { VaultRegistry } from '../serve/vault-registry.js';
import { readBody, readJson, sendJson } from './route-helpers.js';

const PREFIX = '/centraid/_vault/blobs';
/** Upload cap — a phone video fits; a Takeout goes through the import door. */
const MAX_BLOB_BYTES = 512 * 1024 * 1024;

/** `bytes=<start>-<end?>` → a single satisfiable range, else null. */
function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null {
  const m = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null;
  // Suffix form `bytes=-N`: the final N bytes.
  const start = rawStart === '' ? Math.max(0, size - Number(rawEnd)) : Number(rawStart);
  const end = rawStart === '' ? size - 1 : rawEnd === '' ? size - 1 : Number(rawEnd);
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

export function makeBlobRouteHandler(vaults: Pick<VaultRegistry, 'current'>): RouteHandler {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://gateway.local');
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
    const rest = url.pathname.slice(PREFIX.length).replace(/^\//, '');
    const segments = rest === '' ? [] : rest.split('/').map(decodeURIComponent);
    const method = (req.method ?? 'GET').toUpperCase();
    const plane = vaults.current();
    const owner = plane.ownerCredential;

    try {
      if (method === 'POST' && segments.length === 0) {
        const contentType = (req.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '';
        let bytes: Buffer;
        let filename = url.searchParams.get('filename') ?? undefined;
        let mediaType = url.searchParams.get('media_type') ?? undefined;
        let variant = url.searchParams.get('variant') ?? undefined;
        let variantOf = url.searchParams.get('variant_of') ?? undefined;
        if (contentType === 'application/json') {
          const body = await readJson(req, MAX_BLOB_BYTES);
          if (typeof body.base64 !== 'string') {
            return sendJson(res, 400, { error: 'json uploads carry {base64}' });
          }
          bytes = Buffer.from(body.base64, 'base64');
          filename = typeof body.filename === 'string' ? body.filename : filename;
          mediaType = typeof body.media_type === 'string' ? body.media_type : mediaType;
          variant = typeof body.variant === 'string' ? body.variant : variant;
          variantOf = typeof body.variant_of === 'string' ? body.variant_of : variantOf;
        } else {
          // The streaming door: raw bytes, metadata in the query string.
          bytes = await readBody(req, MAX_BLOB_BYTES);
          mediaType = mediaType ?? (contentType || undefined);
        }
        if (bytes.length === 0) return sendJson(res, 400, { error: 'empty upload' });
        if (variant !== undefined && variant !== 'thumb' && variant !== 'preview') {
          return sendJson(res, 400, { error: 'variant must be thumb or preview' });
        }
        const staged = plane.gateway.stageBlob(owner, {
          bytes,
          ...(mediaType ? { mediaType } : {}),
          ...(filename ? { filename } : {}),
          ...(variant ? { variant: variant as 'thumb' | 'preview' } : {}),
          ...(variantOf ? { variantOf } : {}),
        });
        return sendJson(res, 200, {
          sha256: staged.sha256,
          mediaType: staged.mediaType,
          byteSize: staged.byteSize,
          existingContentId: staged.existingContentId,
        });
      }

      if ((method === 'GET' || method === 'HEAD') && segments.length === 1) {
        const variant = url.searchParams.get('variant') ?? undefined;
        const outcome = plane.gateway.resolveBlob(
          owner,
          segments[0] ?? '',
          variant ? { variant } : {},
        );
        if (outcome.status !== 'ok') {
          return sendJson(res, 404, { error: outcome.status });
        }
        const blob = outcome.blob;
        const etag = `"${blob.sha256}"`;
        res.setHeader('ETag', etag);
        res.setHeader('Accept-Ranges', 'bytes');
        // Content-addressed bytes never change under their id+variant —
        // cache forever, privately (this is the owner's data).
        res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
        res.setHeader('Content-Type', blob.mediaType);
        const disposition = url.searchParams.get('download') ? 'attachment' : 'inline';
        const name = (blob.title ?? blob.sha256.slice(0, 12)).replace(/["\\\r\n]/g, '');
        res.setHeader('Content-Disposition', `${disposition}; filename="${name}"`);
        if (req.headers['if-none-match'] === etag) {
          res.statusCode = 304;
          res.end();
          return true;
        }
        const range = parseRange(
          typeof req.headers.range === 'string' ? req.headers.range : undefined,
          blob.byteSize,
        );
        if (typeof req.headers.range === 'string' && !range) {
          res.statusCode = 416;
          res.setHeader('Content-Range', `bytes */${blob.byteSize}`);
          res.end();
          return true;
        }
        if (method === 'HEAD') {
          res.statusCode = 200;
          res.setHeader('Content-Length', String(blob.byteSize));
          res.end();
          return true;
        }
        const bytes = await plane.db.blobs.open(
          blob.sha256,
          range ? { start: range.start, end: range.end } : undefined,
        );
        if (!bytes) return sendJson(res, 404, { error: 'bytes missing from custody' });
        if (range) {
          res.statusCode = 206;
          res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${blob.byteSize}`);
        } else {
          res.statusCode = 200;
        }
        res.setHeader('Content-Length', String(bytes.length));
        res.end(bytes);
        return true;
      }
    } catch (err) {
      // Ingest backpressure (issue #405 §3/§5): the bounded cache spool is full
      // and nothing is safely evictable (un-replicated backlog). This is
      // retryable once replication drains — a 429 with Retry-After, NOT a 400
      // (the request was well-formed) and NOT a 507 (the disk isn't full, the
      // BUDGET is). Never a lost byte: the client re-POSTs and succeeds later.
      if (err instanceof VaultBlobBackpressureError) {
        res.setHeader('Retry-After', '5');
        return sendJson(res, 429, { error: err.message, retryable: true });
      }
      // A genuine ENOSPC on the vault volume (issue #351 wave 4) — the disk is
      // full, not the budget; surface it as 507 Insufficient Storage.
      if (err instanceof VaultDiskFullError) {
        return sendJson(res, 507, { error: err.message });
      }
      return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return sendJson(res, 405, { error: `unsupported ${method} on ${url.pathname}` });
  };
}
