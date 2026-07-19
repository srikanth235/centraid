import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { BlobCustody, ServableBlob } from '@centraid/vault';
import {
  createBlobHandoffUrl,
  DATA_PLANE_RELAY_HEADER,
  isDataPlaneRelayRequest,
  type DataPlaneHttpOptions,
} from '../serve/data-plane-handoff.js';
import { parseRange, pipeBlobResponse } from './blob-response.js';
import { sendJson } from './route-helpers.js';

export async function serveBlobRead(input: {
  req: IncomingMessage;
  res: ServerResponse;
  method: 'GET' | 'HEAD';
  blob: ServableBlob;
  custody: BlobCustody;
  download: boolean;
  dataPlane?: DataPlaneHttpOptions;
}): Promise<true> {
  const { req, res, method, blob, custody, dataPlane } = input;
  const etag = `"${blob.sha256}"`;
  const disposition = input.download ? 'attachment' : 'inline';
  const name = (blob.title ?? blob.sha256.slice(0, 12)).replace(/["\\\r\n]/g, '');
  const setRepresentationHeaders = (): void => {
    res.setHeader('ETag', etag);
    res.setHeader('Accept-Ranges', 'bytes');
    // Content-addressed bytes never change under their id+variant — cache
    // forever, privately (this is the owner's data).
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('Content-Type', blob.mediaType);
    res.setHeader('Content-Disposition', `${disposition}; filename="${name}"`);
  };
  const range = parseRange(
    typeof req.headers.range === 'string' ? req.headers.range : undefined,
    blob.byteSize,
  );
  if (typeof req.headers.range === 'string' && !range) {
    res.statusCode = 416;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Range', `bytes */${blob.byteSize}`);
    res.setHeader('Cache-Control', 'no-store');
    res.end();
    return true;
  }
  const localFile = custody.localPathSync?.(blob.sha256) ?? null;
  const handoff =
    dataPlane &&
    localFile &&
    isDataPlaneRelayRequest(dataPlane, req.headers[DATA_PLANE_RELAY_HEADER])
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
    // Tickets expire after ten seconds and are single-use. A permanent
    // immutable cache policy would preserve an already-spent Location.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', '0');
    res.end();
    return true;
  }
  if (method === 'HEAD') {
    setRepresentationHeaders();
    res.statusCode = 200;
    res.setHeader('Content-Length', String(blob.byteSize));
    res.end();
    return true;
  }
  const requestedRange = range ? { start: range.start, end: range.end } : undefined;
  const opened = custody.openReadStreamSync(blob.sha256, requestedRange);
  let source =
    opened?.stream ?? custody.openRemoteReadStream(blob.sha256, blob.byteSize, requestedRange);
  // Memory-backed vaults have no file-descriptor stream primitive. Preserve
  // the bounded buffered custody fallback for those stores.
  if (!source) {
    const bytes = await custody.open(blob.sha256, requestedRange);
    if (bytes) source = Readable.from(bytes);
  }
  if (!source) return sendJson(res, 404, { error: 'bytes missing from custody' });

  setRepresentationHeaders();
  if (req.headers['if-none-match'] === etag) {
    source.destroy();
    res.statusCode = 304;
    res.removeHeader('Content-Type');
    res.removeHeader('Content-Disposition');
    res.end();
    return true;
  }
  if (range) {
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${blob.byteSize}`);
  } else {
    res.statusCode = 200;
  }
  const contentLength = range ? range.end - range.start + 1 : blob.byteSize;
  res.setHeader('Content-Length', String(contentLength));
  await pipeBlobResponse(req, res, source);
  return true;
}
