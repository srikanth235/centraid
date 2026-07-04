/*
 * Wire protocol for the centraid tunnel (issue #263).
 *
 * Two ALPNs ride one iroh endpoint:
 *
 *   `centraid/tunnel/1` — HTTP forwarding. One QUIC bi-stream per HTTP
 *     request. Each direction is a header frame followed by raw body bytes
 *     until stream FIN. Responses stream (SSE stays live); requests are
 *     read to end before forwarding (tool payloads are small JSON in v0).
 *
 *   `centraid/pair/1` — pairing. One bi-stream: the phone sends a
 *     PairRequest frame (then FIN), the desktop answers a PairResponse
 *     frame (then FIN).
 *
 * A header frame is a u32 big-endian byte length followed by that many
 * bytes of UTF-8 JSON. This file is the reference for the Swift/Kotlin
 * implementations in apps/mobile/modules/centraid-tunnel.
 */

export const TUNNEL_ALPN = 'centraid/tunnel/1';
export const PAIR_ALPN = 'centraid/pair/1';

/** QUIC close code for a tunnel connection from an endpoint not in the allowlist. */
export const CLOSE_UNAUTHORIZED = 401n;

/** Max accepted header-frame JSON size (paths + headers; generous). */
export const MAX_HEADER_FRAME_BYTES = 256 * 1024;

/** Max buffered request body (tool payloads are JSON; uploads are out of scope in v0). */
export const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

/** Chunk size for streamed reads. */
export const READ_CHUNK_BYTES = 64 * 1024;

export type HeaderMap = Record<string, string | string[]>;

export interface TunnelRequestHeader {
  method: string;
  /** Path + query, e.g. `/centraid/notes/` — never a full URL. */
  target: string;
  headers: HeaderMap;
}

export interface TunnelResponseHeader {
  status: number;
  headers: HeaderMap;
}

export interface PairRequest {
  /** One-time pairing code from the QR payload. */
  code: string;
  deviceName: string;
  platform: string;
}

export type PairResponse =
  | { ok: true; deviceId: string; desktopName: string }
  | { ok: false; error: 'invalid_code' | 'expired_code' | 'bad_request' };

/** The JSON the desktop encodes into the "Connect phone" QR. */
export interface PairQrPayload {
  v: 1;
  kind: 'centraid-pair';
  /** iroh EndpointTicket (base32) — carries the desktop's EndpointId + dial info. */
  ticket: string;
  /** One-time pairing code, consumed on first successful pair. */
  code: string;
}

export function parsePairQrPayload(raw: string): PairQrPayload | undefined {
  try {
    const obj = JSON.parse(raw) as Partial<PairQrPayload>;
    if (obj.v !== 1 || obj.kind !== 'centraid-pair') return undefined;
    if (typeof obj.ticket !== 'string' || typeof obj.code !== 'string') return undefined;
    return { v: 1, kind: 'centraid-pair', ticket: obj.ticket, code: obj.code };
  } catch {
    return undefined;
  }
}

export function alpnBytes(alpn: string): Array<number> {
  return Array.from(Buffer.from(alpn, 'utf8'));
}

/** Encode a header frame: u32 BE length + UTF-8 JSON. */
export function encodeHeaderFrame(header: unknown): Array<number> {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const frame = Buffer.alloc(4 + json.length);
  frame.writeUInt32BE(json.length, 0);
  json.copy(frame, 4);
  return Array.from(frame);
}

interface FrameRecv {
  readExact(size: number): Promise<Array<number>>;
}

interface ChunkRecv {
  read(sizeLimit: number): Promise<Array<number>>;
}

/** Read one header frame. Throws on oversized or malformed frames. */
export async function readHeaderFrame<T>(recv: FrameRecv): Promise<T> {
  const lenBytes = Buffer.from(await recv.readExact(4));
  const len = lenBytes.readUInt32BE(0);
  if (len === 0 || len > MAX_HEADER_FRAME_BYTES) {
    throw new Error(`tunnel: header frame length ${len} out of bounds`);
  }
  const jsonBytes = Buffer.from(await recv.readExact(len));
  return JSON.parse(jsonBytes.toString('utf8')) as T;
}

/**
 * Read body bytes until stream FIN, invoking `onChunk` per chunk.
 * iroh-js signals EOF with an empty read (validated in the Phase 0 spike).
 */
export async function readBody(
  recv: ChunkRecv,
  onChunk: (chunk: Buffer) => void | Promise<void>,
  maxBytes = Number.POSITIVE_INFINITY,
): Promise<void> {
  let total = 0;
  for (;;) {
    const chunk = await recv.read(READ_CHUNK_BYTES);
    if (!chunk || chunk.length === 0) return;
    total += chunk.length;
    if (total > maxBytes) throw new Error('tunnel: body exceeds limit');
    await onChunk(Buffer.from(chunk));
  }
}

/** Read an entire body into one buffer (request side; bounded). */
export async function readBodyToEnd(
  recv: ChunkRecv,
  maxBytes = MAX_REQUEST_BODY_BYTES,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await readBody(recv, (c) => void chunks.push(c), maxBytes);
  return Buffer.concat(chunks);
}

/** Hop-by-hop headers that must not cross the tunnel (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Drop hop-by-hop headers; lowercases every name. */
export function sanitizeHeaders(headers: HeaderMap): HeaderMap {
  const out: HeaderMap = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}
