export const TUNNEL_ALPN = "centraid/tunnel/1";
export const PAIR_ALPN = "centraid/pair/1";
export const PEER_LINK_ALPN = "centraid/gw-link/1";
export const TUNNEL_AUTH_MODE_HEADER = "x-centraid-tunnel-auth-mode";
export const TUNNEL_AUTH_WEB_SESSION = "web-session";

export const DEVICE_IDENTITY_HEADER = "x-centraid-device";
export const DEVICE_PROOF_HEADER = "x-centraid-device-proof";
export const TUNNEL_FORWARDED_HEADER = "x-centraid-tunnel-forwarded";

export const PEER_PLANE_PREFIX = "/centraid/_peer/";

export const PEER_ENDPOINT_HEADER = "x-centraid-peer-endpoint";
export const PEER_PROOF_HEADER = "x-centraid-peer-proof";
export const PEER_VAULT_HEADER = "x-centraid-peer-vault";

export function isPeerPlaneTarget(target: unknown): target is string {
  if (typeof target !== "string") return false;
  if (!isWellFormedTarget(target)) return false;
  if (!target.startsWith(PEER_PLANE_PREFIX)) return false;
  const path = target.split(/[?#]/u)[0] ?? "";
  if (path.length <= PEER_PLANE_PREFIX.length) return false;
  for (const byte of Buffer.from(path, "utf8")) {
    if (byte === 0x25 || byte === 0x5c || byte <= 0x20) return false;
  }
  return path
    .split("/")
    .every((segment) => segment !== "." && segment !== "..");
}

function isWellFormedTarget(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd8_00 && code <= 0xdb_ff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc_00 || next > 0xdf_ff) return false;
      index += 1;
    } else if (code >= 0xdc_00 && code <= 0xdf_ff) {
      return false;
    }
  }
  return true;
}

export const CLOSE_UNAUTHORIZED = 401n;

export const MAX_HEADER_FRAME_BYTES = 256 * 1024;

export const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

export const READ_CHUNK_BYTES = 64 * 1024;

export type HeaderMap = Record<string, string | string[]>;

export interface TunnelRequestHeader {
  method: string;
  target: string;
  headers: HeaderMap;
}

export interface TunnelResponseHeader {
  status: number;
  headers: HeaderMap;
}

export interface PairRequest {
  code: string;
  deviceName: string;
  platform: string;
}

export type PairResponse =
  | {
      ok: true;
      gatewayId: string;
      deviceId: string;
      desktopName: string;
    }
  | { ok: false; error: "invalid_code" | "expired_code" | "bad_request" };

export interface PairQrPayload {
  v: 1;
  kind: "centraid-pair";
  ticket: string;
  code: string;
}

export function parsePairQrPayload(raw: string): PairQrPayload | undefined {
  try {
    const obj = JSON.parse(raw) as Partial<PairQrPayload>;
    if (obj.v !== 1 || obj.kind !== "centraid-pair") return undefined;
    if (typeof obj.ticket !== "string" || typeof obj.code !== "string")
      return undefined;
    return { v: 1, kind: "centraid-pair", ticket: obj.ticket, code: obj.code };
  } catch {
    return undefined;
  }
}

export function alpnBytes(alpn: string): Array<number> {
  return Array.from(Buffer.from(alpn, "utf8"));
}

export function encodeHeaderFrame(header: unknown): Array<number> {
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const frame = Buffer.alloc(4 + json.length);
  frame.writeUInt32BE(json.length, 0);
  json.copy(frame, 4);
  return Array.from(frame);
}

interface FrameRecv {
  readExact: (size: number) => Promise<Array<number>>;
}

interface ChunkRecv {
  read: (sizeLimit: number) => Promise<Array<number>>;
}

export async function readHeaderFrame<T>(recv: FrameRecv): Promise<T> {
  const lenBytes = Buffer.from(await recv.readExact(4));
  const len = lenBytes.readUInt32BE(0);
  if (len === 0 || len > MAX_HEADER_FRAME_BYTES) {
    throw new Error(`tunnel: header frame length ${len} out of bounds`);
  }
  const jsonBytes = Buffer.from(await recv.readExact(len));
  return JSON.parse(jsonBytes.toString("utf8")) as T;
}

export async function readBody(
  recv: ChunkRecv,
  onChunk: (chunk: Buffer) => void | Promise<void>,
  maxBytes = Number.POSITIVE_INFINITY
): Promise<void> {
  let total = 0;
  const readNext = async (): Promise<void> => {
    const chunk = await recv.read(READ_CHUNK_BYTES);
    if (!chunk || chunk.length === 0) return;
    total += chunk.length;
    if (total > maxBytes) throw new Error("tunnel: body exceeds limit");
    await onChunk(Buffer.from(chunk));
    return readNext();
  };
  return readNext();
}

export async function readBodyToEnd(
  recv: ChunkRecv,
  maxBytes = MAX_REQUEST_BODY_BYTES
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await readBody(recv, (c) => void chunks.push(c), maxBytes);
  return Buffer.concat(chunks);
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

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
