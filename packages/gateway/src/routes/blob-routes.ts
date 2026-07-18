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
//        consent + DERIVED-reachability gated: Range, ETag = sha256
//        immutable caching), inline disposition — ?download=1 for saves.
//        Outer Bearer + vault-scope auth (#289) is stamped onto <img>/<video>
//        subresource loads without app-level token plumbing.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { AUTHED_DEVICE_HEADER } from '@centraid/app-engine';
import {
  DERIVATIVE_VARIANTS,
  isDerivativeVariant,
  readBackupPolicy,
  type CommittedBlob,
  type StagedBlob,
} from '@centraid/vault';
import type { RouteHandler } from '../serve/build-gateway.js';
import { vaultContext } from '../serve/vault-context.js';
import type { VaultRegistry } from '../serve/vault-registry.js';
import { createBlobHandoffUrl, type DataPlaneHttpOptions } from '../serve/data-plane-handoff.js';
import { openBlobCustodyEvents } from './blob-custody-events.js';
import { parseRange, pipeBlobResponse } from './blob-response.js';
import { sendBlobRouteError } from './blob-route-errors.js';
import { readBody, readJson, sendJson } from './route-helpers.js';

export { MAX_OPEN_RANGE_BYTES, parseRange } from './blob-response.js';

const PREFIX = '/centraid/_vault/blobs';
/** Upload cap — a phone video fits; a Takeout goes through the import door. */
const MAX_BLOB_BYTES = 512 * 1024 * 1024;
const MAX_UPLOAD_CHUNK_BYTES = 32 * 1024 * 1024;

function stagedJson(staged: StagedBlob | CommittedBlob): Record<string, unknown> {
  return {
    sha256: staged.sha256,
    mediaType: staged.mediaType,
    byteSize: staged.byteSize,
    existingContentId: staged.existingContentId,
    ...('casAck' in staged
      ? {
          casAck: staged.casAck,
          custody: staged.custody,
          acknowledged:
            staged.casAck === 'receipt' ||
            staged.custody === 'replicated' ||
            staged.custody === 'remote-only',
        }
      : {}),
  };
}

function committedStatus(staged: CommittedBlob): 200 | 202 {
  return staged.casAck === 'replicated' && staged.custody === 'pending-offsite' ? 202 : 200;
}

function sendCommitted(res: ServerResponse, staged: CommittedBlob): true {
  return sendJson(res, committedStatus(staged), stagedJson(staged));
}

function optionalSize(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > MAX_BLOB_BYTES) {
    throw new Error(`${field} must be an integer from 0 through ${MAX_BLOB_BYTES}`);
  }
  return number;
}

/** Only host-stamped transport identity may receive per-blob key material. */
function authenticatedDevice(req: IncomingMessage): string | undefined {
  const ambient = vaultContext()?.deviceKey;
  if (ambient) return ambient;
  const raw = req.headers[AUTHED_DEVICE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function makeBlobRouteHandler(
  vaults: Pick<VaultRegistry, 'current'>,
  dataPlane?: DataPlaneHttpOptions,
): RouteHandler {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://gateway.local');
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
    const rest = url.pathname.slice(PREFIX.length).replace(/^\//, '');
    const segments = rest === '' ? [] : rest.split('/').map(decodeURIComponent);
    const method = (req.method ?? 'GET').toUpperCase();
    const plane = vaults.current();
    const owner = plane.ownerCredential;
    const casAck = readBackupPolicy(plane.db.vault).casAck;

    try {
      if (method === 'POST' && segments.length === 0) {
        const contentType = (req.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '';
        let filename = url.searchParams.get('filename') ?? undefined;
        let mediaType = url.searchParams.get('media_type') ?? undefined;
        let variant = url.searchParams.get('variant') ?? undefined;
        let variantOf = url.searchParams.get('variant_of') ?? undefined;
        if (contentType === 'application/json') {
          const body = await readJson(req, MAX_BLOB_BYTES);
          if (typeof body.base64 !== 'string') {
            return sendJson(res, 400, { error: 'json uploads carry {base64}' });
          }
          const bytes = Buffer.from(body.base64, 'base64');
          filename = typeof body.filename === 'string' ? body.filename : filename;
          mediaType = typeof body.media_type === 'string' ? body.media_type : mediaType;
          variant = typeof body.variant === 'string' ? body.variant : variant;
          variantOf = typeof body.variant_of === 'string' ? body.variant_of : variantOf;
          if (bytes.length === 0) return sendJson(res, 400, { error: 'empty upload' });
          if (variant !== undefined && !isDerivativeVariant(variant)) {
            return sendJson(res, 400, {
              error: `variant must be one of ${DERIVATIVE_VARIANTS.join(', ')}`,
            });
          }
          if ((variant === undefined) !== (variantOf === undefined)) {
            return sendJson(res, 400, {
              error: 'variant and variant_of must be supplied together',
            });
          }
          const staged = plane.gateway.stageBlob(owner, {
            bytes,
            ...(mediaType ? { mediaType } : {}),
            ...(filename ? { filename } : {}),
            ...(variant ? { variant, validateDerivative: true } : {}),
            ...(variantOf ? { variantOf } : {}),
          });
          const custody = (await plane.db.blobTransfers.preflight(staged.sha256)).custody;
          return sendCommitted(res, { ...staged, casAck, custody });
        }

        // Derivative uploads retain the buffered preview pipeline. Originals
        // use the persistent streaming coordinator below.
        if (variant !== undefined) {
          if (!isDerivativeVariant(variant)) {
            return sendJson(res, 400, {
              error: `variant must be one of ${DERIVATIVE_VARIANTS.join(', ')}`,
            });
          }
          if (!variantOf) {
            return sendJson(res, 400, {
              error: 'variant and variant_of must be supplied together',
            });
          }
          const bytes = await readBody(req, MAX_BLOB_BYTES);
          if (bytes.length === 0) return sendJson(res, 400, { error: 'empty upload' });
          const staged = plane.gateway.stageBlob(owner, {
            bytes,
            mediaType: mediaType ?? (contentType || undefined),
            ...(filename ? { filename } : {}),
            variant,
            variantOf,
            validateDerivative: true,
          });
          const custody = (await plane.db.blobTransfers.preflight(staged.sha256)).custody;
          return sendCommitted(res, { ...staged, casAck, custody });
        }
        if (variantOf !== undefined) {
          return sendJson(res, 400, { error: 'variant and variant_of must be supplied together' });
        }

        mediaType = mediaType ?? (contentType || undefined);
        const expectedSha =
          typeof req.headers['x-content-sha256'] === 'string'
            ? req.headers['x-content-sha256']
            : typeof req.headers['x-centraid-sha256'] === 'string'
              ? req.headers['x-centraid-sha256']
              : (url.searchParams.get('sha256') ?? undefined);
        const expectedSize = optionalSize(req.headers['content-length'], 'Content-Length');
        const begin = await plane.db.blobTransfers.beginIngress({
          ...(expectedSha ? { expectedSha256: expectedSha } : {}),
          ...(expectedSize !== undefined ? { expectedSize } : {}),
          ...(mediaType ? { mediaType } : {}),
          ...(filename ? { filename } : {}),
          stagedBy: plane.boot.deviceId,
        });
        if (begin.mode === 'existing') {
          return sendJson(res, 200, {
            ...stagedJson(begin.staged),
            casAck,
            custody: begin.custody,
          });
        }
        if (begin.mode === 'one-shot-stream-through') {
          const staged = await plane.db.blobTransfers.streamThrough(
            {
              expectedSha256: begin.expectedSha256,
              expectedSize: begin.expectedSize,
              ...(mediaType ? { mediaType } : {}),
              ...(filename ? { filename } : {}),
              stagedBy: plane.boot.deviceId,
            },
            req,
          );
          return sendCommitted(res, staged);
        }
        if (begin.mode === 'one-shot-hash-pending') {
          return sendCommitted(
            res,
            await plane.db.blobTransfers.streamThrough(
              {
                expectedSize: begin.expectedSize,
                ...(mediaType ? { mediaType } : {}),
                ...(filename ? { filename } : {}),
                stagedBy: plane.boot.deviceId,
              },
              req,
            ),
          );
        }
        let offset = 0;
        try {
          for await (const value of req as AsyncIterable<Buffer | string>) {
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
            if (chunk.length > MAX_BLOB_BYTES - offset) {
              throw new Error(`upload exceeds ${MAX_BLOB_BYTES} bytes`);
            }
            offset = (await plane.db.blobTransfers.appendIngress(begin.sessionId, offset, chunk))
              .offset;
          }
        } catch (error) {
          await plane.db.blobTransfers.abortIngress(begin.sessionId);
          throw error;
        }
        if (offset === 0) {
          await plane.db.blobTransfers.abortIngress(begin.sessionId);
          return sendJson(res, 400, { error: 'empty upload' });
        }
        const committed = await plane.db.blobTransfers.commitIngress(begin.sessionId);
        return sendCommitted(res, committed);
      }

      if (method === 'HEAD' && segments[0] === '_sha' && segments.length === 2) {
        const byteSize = optionalSize(url.searchParams.get('byte_size'), 'byte_size');
        const status = await plane.db.blobTransfers.preflight(segments[1] ?? '', {
          ...(byteSize !== undefined ? { byteSize } : {}),
          ...(url.searchParams.get('media_type')
            ? { mediaType: url.searchParams.get('media_type')! }
            : {}),
          ...(url.searchParams.get('filename')
            ? { filename: url.searchParams.get('filename')! }
            : {}),
          stagedBy: plane.boot.deviceId,
        });
        res.statusCode = status.exists ? 200 : 404;
        res.setHeader('X-Centraid-Exists', String(status.exists));
        res.setHeader('X-Centraid-Custody', status.custody);
        res.setHeader('X-Centraid-Cas-Ack', casAck);
        res.setHeader('X-Centraid-Staged', String(status.staged));
        if (status.staged) res.setHeader('X-Centraid-Staged-Sha256', segments[1]!);
        if (status.byteSize !== undefined) res.setHeader('Content-Length', String(status.byteSize));
        if (status.mediaType) res.setHeader('X-Centraid-Media-Type', status.mediaType);
        if (status.contentId) res.setHeader('X-Centraid-Content-Id', status.contentId);
        res.end();
        return true;
      }

      if (
        method === 'GET' &&
        segments[0] === '_sha' &&
        segments[2] === 'events' &&
        segments.length === 3
      ) {
        await openBlobCustodyEvents({
          req,
          res,
          transfers: plane.db.blobTransfers,
          sha256: segments[1]!,
          casAck,
        });
        return true;
      }

      if (method === 'POST' && segments[0] === 'uploads' && segments.length === 1) {
        const body = await readJson(req);
        const expectedSize = optionalSize(body.expectedSize, 'expectedSize');
        const stagedBy = authenticatedDevice(req) ?? plane.boot.deviceId;
        const result = await plane.db.blobTransfers.beginIngress({
          ...(typeof body.expectedSha256 === 'string'
            ? { expectedSha256: body.expectedSha256 }
            : {}),
          ...(expectedSize !== undefined ? { expectedSize } : {}),
          ...(typeof body.mediaType === 'string' ? { mediaType: body.mediaType } : {}),
          ...(typeof body.filename === 'string' ? { filename: body.filename } : {}),
          stagedBy,
          resumable: true,
        });
        return sendJson(res, result.mode === 'existing' ? 200 : 201, { ...result, casAck });
      }

      if (method === 'PATCH' && segments[0] === 'uploads' && segments.length === 2) {
        const offset = optionalSize(req.headers['upload-offset'], 'Upload-Offset');
        if (offset === undefined) return sendJson(res, 400, { error: 'Upload-Offset is required' });
        const chunk = await readBody(req, MAX_UPLOAD_CHUNK_BYTES);
        const next = await plane.db.blobTransfers.appendIngress(segments[1]!, offset, chunk);
        res.statusCode = 204;
        res.setHeader('Upload-Offset', String(next.offset));
        res.end();
        return true;
      }

      if (
        method === 'PUT' &&
        segments[0] === 'direct' &&
        segments[2] === 'parts' &&
        segments.length === 4
      ) {
        const deviceIdentity = authenticatedDevice(req);
        if (!deviceIdentity) {
          return sendJson(res, 403, { error: 'direct upload requires a paired device' });
        }
        const body = await readJson(req);
        const completedParts = plane.db.blobTransfers.recordDirectPart(
          segments[1]!,
          Number(segments[3]),
          typeof body.etag === 'string' ? body.etag : '',
          deviceIdentity,
        );
        return sendJson(res, 200, { completedParts });
      }

      if (
        method === 'POST' &&
        segments[0] === 'uploads' &&
        segments[2] === 'commit' &&
        segments.length === 3
      ) {
        return sendCommitted(res, await plane.db.blobTransfers.commitIngress(segments[1]!));
      }

      if (method === 'DELETE' && segments[0] === 'uploads' && segments.length === 2) {
        await plane.db.blobTransfers.abortIngress(segments[1]!);
        res.statusCode = 204;
        res.end();
        return true;
      }

      if (method === 'POST' && segments[0] === 'direct' && segments.length === 1) {
        const deviceIdentity = authenticatedDevice(req);
        if (!deviceIdentity) {
          return sendJson(res, 403, { error: 'direct upload requires a paired device' });
        }
        const body = await readJson(req);
        if (typeof body.sha256 !== 'string')
          return sendJson(res, 400, { error: 'sha256 is required' });
        const plaintextSize = optionalSize(body.plaintextSize, 'plaintextSize');
        const sealedSize = optionalSize(body.sealedSize, 'sealedSize');
        if (plaintextSize === undefined || sealedSize === undefined) {
          return sendJson(res, 400, { error: 'plaintextSize and sealedSize are required' });
        }
        const result = await plane.db.blobTransfers.beginDirect({
          sha256: body.sha256,
          plaintextSize,
          sealedSize,
          ...(body.partCount !== undefined ? { partCount: Number(body.partCount) } : {}),
          ...(typeof body.mediaType === 'string' ? { mediaType: body.mediaType } : {}),
          ...(typeof body.filename === 'string' ? { filename: body.filename } : {}),
          stagedBy: deviceIdentity,
          deviceId: deviceIdentity,
        });
        return sendJson(res, result.alreadyPresent ? 200 : 201, { ...result, casAck });
      }

      if (
        method === 'POST' &&
        segments[0] === 'direct' &&
        segments[2] === 'complete' &&
        segments.length === 3
      ) {
        const deviceIdentity = authenticatedDevice(req);
        if (!deviceIdentity) {
          return sendJson(res, 403, { error: 'direct upload requires a paired device' });
        }
        const body = await readJson(req);
        const parts = Array.isArray(body.parts)
          ? body.parts.map((part) => ({
              partNumber: Number((part as Record<string, unknown>).partNumber),
              etag: String((part as Record<string, unknown>).etag ?? ''),
            }))
          : [];
        return sendCommitted(
          res,
          await plane.db.blobTransfers.completeDirect(segments[1]!, deviceIdentity, parts),
        );
      }

      if (
        method === 'GET' &&
        segments[0] === 'direct' &&
        segments[2] === 'download' &&
        segments.length === 3
      ) {
        const deviceIdentity = authenticatedDevice(req);
        if (!deviceIdentity) {
          return sendJson(res, 403, { error: 'direct download requires a paired device' });
        }
        return sendJson(
          res,
          200,
          await plane.db.blobTransfers.directDownload(segments[1]!, deviceIdentity),
        );
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
        const localFile = plane.db.blobs.localPathSync?.(blob.sha256) ?? null;
        const handoff =
          dataPlane && localFile
            ? createBlobHandoffUrl(dataPlane, {
                file: localFile,
                mediaType: blob.mediaType,
                disposition: `${disposition}; filename="${name}"`,
                etag,
              })
            : undefined;
        if (handoff) {
          res.statusCode = 307;
          res.setHeader('Location', handoff);
          res.setHeader('Content-Length', '0');
          res.end();
          return true;
        }
        if (method === 'HEAD') {
          res.statusCode = 200;
          res.setHeader('Content-Length', String(blob.byteSize));
          res.end();
          return true;
        }
        const requestedRange = range ? { start: range.start, end: range.end } : undefined;
        const opened = plane.db.blobs.openReadStreamSync(blob.sha256, requestedRange);
        if (range) {
          res.statusCode = 206;
          res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${blob.byteSize}`);
        } else {
          res.statusCode = 200;
        }
        const contentLength = range ? range.end - range.start + 1 : blob.byteSize;
        res.setHeader('Content-Length', String(contentLength));
        if (opened) {
          await pipeBlobResponse(req, res, opened.stream);
          return true;
        }
        const remoteStream = plane.db.blobs.openRemoteReadStream(
          blob.sha256,
          blob.byteSize,
          requestedRange,
        );
        if (!remoteStream) return sendJson(res, 404, { error: 'bytes missing from custody' });
        await pipeBlobResponse(req, res, remoteStream);
        return true;
      }
    } catch (error) {
      return sendBlobRouteError(res, error);
    }
    return sendJson(res, 405, { error: `unsupported ${method} on ${url.pathname}` });
  };
}
