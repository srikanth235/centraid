import crypto from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { createNativeImagePreviewCodec } from '../preview/native-codec.js';

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_RANGE_BYTES = 4 * 1024 * 1024;

interface BlobTicket {
  relativePath: string;
  expiresAtMs: number;
  nonce: string;
  mediaType: string;
  disposition: string;
  etag: string;
}

export interface TypeScriptBytePlaneHandle {
  baseUrl: string;
  close(): Promise<void>;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function equalText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function authorized(req: http.IncomingMessage, secret: string): boolean {
  return equalText(String(req.headers['x-centraid-data-plane-secret'] ?? ''), secret);
}

async function collect(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk as Uint8Array);
    total += bytes.length;
    if (total > MAX_BODY_BYTES) throw new RangeError('body_too_large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function safePath(root: string, relativePath: string): string | undefined {
  if (!relativePath || path.isAbsolute(relativePath)) return undefined;
  const candidate = path.resolve(root, relativePath);
  const relative = path.relative(root, candidate);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? candidate
    : undefined;
}

function verifyTicket(secret: string, encoded: string): BlobTicket | undefined {
  const separator = encoded.lastIndexOf('.');
  if (separator < 1) return undefined;
  const payload = encoded.slice(0, separator);
  const supplied = encoded.slice(separator + 1);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (!equalText(supplied, expected)) return undefined;
  try {
    const ticket = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as BlobTicket;
    return ticket.expiresAtMs >= Date.now() && ticket.nonce ? ticket : undefined;
  } catch {
    return undefined;
  }
}

function parseRange(raw: string | undefined, size: number): [number, number] | undefined {
  if (!raw?.startsWith('bytes=') || raw.includes(',')) return undefined;
  const [startText, endText] = raw.slice(6).split('-', 2);
  if (startText === '') {
    const suffix = Math.min(Number(endText), size);
    return Number.isSafeInteger(suffix) && suffix > 0 ? [size - suffix, size - 1] : undefined;
  }
  const start = Number(startText);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return undefined;
  const end =
    endText === ''
      ? Math.min(size - 1, start + MAX_RANGE_BYTES - 1)
      : Math.min(size - 1, Number(endText));
  return Number.isSafeInteger(end) && end >= start ? [start, end] : undefined;
}

async function serveBlob(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  root: string,
  secret: string,
  nonces: Set<string>,
): Promise<void> {
  const ticket = verifyTicket(secret, url.searchParams.get('ticket') ?? '');
  if (!ticket || nonces.has(ticket.nonce)) return sendJson(res, 401, { error: 'invalid_ticket' });
  nonces.add(ticket.nonce);
  const file = safePath(root, ticket.relativePath);
  if (!file) return sendJson(res, 403, { error: 'invalid_path' });
  const canonicalRoot = await fs.realpath(root);
  const canonical = await fs.realpath(file).catch(() => undefined);
  if (!canonical || !canonical.startsWith(`${canonicalRoot}${path.sep}`)) {
    return sendJson(res, 404, { error: 'blob_not_found' });
  }
  const size = (await fs.stat(canonical)).size;
  const rawRange = typeof req.headers.range === 'string' ? req.headers.range : undefined;
  const range = rawRange ? parseRange(rawRange, size) : ([0, size - 1] as [number, number]);
  if (!range) {
    res.setHeader('content-range', `bytes */${size}`);
    return sendJson(res, 416, { error: 'invalid_range' });
  }
  const [start, end] = range;
  const headers: http.OutgoingHttpHeaders = {
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=31536000, immutable',
    'content-length': end - start + 1,
    'content-type': ticket.mediaType,
    'content-disposition': ticket.disposition,
    etag: ticket.etag,
    ...(rawRange ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
  };
  res.writeHead(rawRange ? 206 : 200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(canonical, { start, end }).pipe(res);
}

async function compress(bytes: Buffer): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    zlib.zstdCompress(bytes, (error, output) => {
      if (error) reject(error);
      else resolve(output);
    });
  });
}

interface PumpInput {
  relativePath: string;
  destinationUrl: string;
  headers?: Record<string, string>;
  offset?: number;
  length?: number;
}

async function pump(
  root: string,
  input: PumpInput,
): Promise<{
  byteSize: number;
  providerStatus: number;
  etag?: string;
}> {
  const destination = new URL(input.destinationUrl);
  if (
    destination.protocol !== 'https:' &&
    !(
      destination.protocol === 'http:' &&
      (destination.hostname === '127.0.0.1' || destination.hostname === 'localhost')
    )
  ) {
    throw new Error('invalid_destination');
  }
  const file = safePath(root, input.relativePath);
  if (!file) throw new Error('invalid_path');
  const stat = await fs.stat(file);
  const offset = input.offset ?? 0;
  const length = input.length ?? stat.size - offset;
  if (offset < 0 || length < 0 || offset + length > stat.size) throw new Error('invalid_window');
  const transport = destination.protocol === 'https:' ? https : http;
  return await new Promise((resolve, reject) => {
    const request = transport.request(
      destination,
      {
        method: 'PUT',
        headers: { ...input.headers, 'content-length': String(length) },
      },
      (response) => {
        response.resume();
        response.once('end', () =>
          resolve({
            byteSize: length,
            providerStatus: response.statusCode ?? 502,
            ...(response.headers.etag ? { etag: response.headers.etag } : {}),
          }),
        );
      },
    );
    request.once('error', reject);
    if (length === 0) request.end();
    else createReadStream(file, { start: offset, end: offset + length - 1 }).pipe(request);
  });
}

export async function startTypeScriptBytePlane(options: {
  root: string;
  secret: string;
}): Promise<TypeScriptBytePlaneHandle> {
  const root = await fs.realpath(options.root);
  const nonces = new Set<string>();
  const previewCodec = createNativeImagePreviewCodec();
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://byte-plane.local');
      if (url.pathname === '/v1/health' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
        return;
      }
      if (url.pathname === '/v1/blob' && (req.method === 'GET' || req.method === 'HEAD')) {
        await serveBlob(req, res, url, root, options.secret, nonces);
        return;
      }
      if (!authorized(req, options.secret)) {
        sendJson(res, 403, { error: 'invalid_data_plane_secret' });
        return;
      }
      if (url.pathname === '/v1/hash' && req.method === 'POST') {
        const digest = crypto.createHash('sha256');
        let byteSize = 0;
        for await (const chunk of req) {
          const bytes = Buffer.from(chunk as Uint8Array);
          byteSize += bytes.length;
          digest.update(bytes);
        }
        sendJson(res, 200, { sha256: digest.digest('hex'), byteSize });
        return;
      }
      if (url.pathname === '/v1/compress' && req.method === 'POST') {
        const output = await compress(await collect(req));
        res.writeHead(200, { 'content-type': 'application/zstd' }).end(output);
        return;
      }
      if (url.pathname === '/v1/preview' && req.method === 'POST') {
        const edge = Number(url.searchParams.get('edge') ?? 256);
        if (!Number.isInteger(edge) || edge < 32 || edge > 4096) {
          return sendJson(res, 400, { error: 'invalid_edge' });
        }
        const output = await previewCodec.downscale(await collect(req), 'image/png', edge);
        if (!output) return sendJson(res, 415, { error: 'preview_failed' });
        res.writeHead(200, { 'content-type': output.mediaType }).end(output.bytes);
        return;
      }
      if (url.pathname === '/v1/pump' && req.method === 'POST') {
        const result = await pump(root, JSON.parse((await collect(req)).toString()) as PumpInput);
        sendJson(
          res,
          result.providerStatus >= 200 && result.providerStatus < 300 ? 200 : 502,
          result,
        );
        return;
      }
      sendJson(res, 404, { error: 'not_found' });
    })().catch((error) => {
      if (!res.headersSent)
        sendJson(res, error instanceof RangeError ? 413 : 400, { error: String(error) });
      else res.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
