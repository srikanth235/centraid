/*
 * Wire protocol for the centraid tunnel (issue #263).
 *
 * Three ALPNs ride one iroh endpoint:
 *
 *   `centraid/tunnel/1` — HTTP forwarding. One QUIC bi-stream per HTTP
 *     request. Each direction is a header frame followed by raw body bytes
 *     until stream FIN. Both request and response bodies stream with bounded
 *     backpressure so concurrent uploads never multiply the old 32 MiB cap.
 *
 *   `centraid/pair/1` — pairing. One bi-stream: the phone sends a
 *     PairRequest frame (then FIN), the desktop answers a PairResponse
 *     frame (then FIN).
 *
 *   `centraid/gw-link/1` — the gateway↔GATEWAY peer plane (#726 P3).
 *     Same framing, confined to `/centraid/_peer/*`, with its own admission
 *     decision and its own identity headers. A CLIENT never speaks it: it is
 *     deliberately absent from fixtures/wire-golden.json, because the Swift
 *     and Kotlin conformance suites read that fixture as their to-do list and
 *     a phone has no links.
 *
 * A header frame is a u32 big-endian byte length followed by that many
 * bytes of UTF-8 JSON. This file is the reference for the Swift/Kotlin
 * implementations in apps/mobile/modules/centraid-tunnel.
 */

export const TUNNEL_ALPN = "centraid/tunnel/1";
export const PAIR_ALPN = "centraid/pair/1";
/**
 * Gateway↔gateway peer plane (issue #726 P3). A LINK is not a pairing: the
 * caller is another gateway acting for its own vault, never a device acting
 * for this gateway's owner. Byte-mirrored in
 * `data-plane/src/lib.rs::PEER_LINK_ALPN`; the two are pinned against each
 * other by `alpn-parity.test.ts` because a drift only surfaces at ALPN
 * negotiation, in production, on the wire.
 */
export const PEER_LINK_ALPN = "centraid/gw-link/1";
/** Ask the tunnel to defer auth to a gateway-scoped browser app session cookie. */
export const TUNNEL_AUTH_MODE_HEADER = "x-centraid-tunnel-auth-mode";
export const TUNNEL_AUTH_WEB_SESSION = "web-session";

/*
 * Loopback is not an identity (issue #568 item A).
 *
 * Every forwarder in this repo delivers a REMOTE peer to a loopback HTTP
 * listener, so the socket address proves nothing about who is calling. The
 * three headers below are the wire contract that lets the HTTP layer tell
 * a real host request from a forwarded one. Each forwarder MUST delete any
 * client-supplied copy before it stamps its own.
 */
/** EndpointId the QUIC handshake proved. Stamped only by an identity-bearing forwarder. */
export const DEVICE_IDENTITY_HEADER = "x-centraid-device";
/** In-process proof that `DEVICE_IDENTITY_HEADER` came from the forwarder, not the client. */
export const DEVICE_PROOF_HEADER = "x-centraid-device-proof";
/**
 * Stamped by every forwarder, including the ones that cannot prove a device
 * identity (the desktop phone tunnel forwards under the host's own bearer).
 * Its presence disqualifies a request from host-only capabilities such as
 * minting a founding ticket.
 */
export const TUNNEL_FORWARDED_HEADER = "x-centraid-tunnel-forwarded";

/*
 * The peer plane (issue #726 P3 decision 6).
 *
 * A linked peer gateway reaches EXACTLY the routes under this prefix and
 * nothing else. The forwarded `target` is peer-supplied and is concatenated
 * onto the local upstream URL by every forwarder, so without this guard a
 * link would address the whole owner surface — `/centraid/_gateway/*`
 * included. The confinement is enforced twice on purpose: once in the Rust
 * relay (`data-plane/src/iroh_relay.rs::peer_target_allowed`, the production
 * path) and once here (the pure-JS endpoint), so loosening either one alone
 * does not open the door.
 */
export const PEER_PLANE_PREFIX = "/centraid/_peer/";

/** EndpointId the peer's QUIC handshake proved. Stamped only by a forwarder. */
export const PEER_ENDPOINT_HEADER = "x-centraid-peer-endpoint";
/** In-process proof that the two headers above came from the forwarder. */
export const PEER_PROOF_HEADER = "x-centraid-peer-proof";

/**
 * Is `target` confined to the peer plane?
 *
 * Constraints, mirrored byte-for-byte in Rust:
 *  - the target must be well-formed UTF-16, i.e. hold no lone surrogate. A
 *    Rust `&str` cannot carry one at all, so a JS guard that judged the
 *    UTF-8 re-encoding (which silently rewrites a lone surrogate to U+FFFD)
 *    would be judging a different string than the one it forwards, and would
 *    admit a target the Rust lane can never represent (#846 P7);
 *  - the PATH — everything before `?`/`#` — must extend `PEER_PLANE_PREFIX`.
 *    A bare prefix addresses no resource, and measuring the whole target
 *    instead let a lone `?` or `#` stand in for that extension (#846 P6);
 *  - the path carries no percent escape, no backslash, and no byte at or
 *    below 0x20 — the peer plane's own routes never need them, and admitting
 *    them would mean re-implementing URL normalisation identically in two
 *    languages to stay safe;
 *  - no `.` or `..` segment, so the concatenated upstream URL cannot climb
 *    out of the plane.
 */
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

/**
 * Is `value` representable as a Rust `&str` — every high surrogate followed by
 * a low one, and no low surrogate standing alone?
 *
 * Spelled out rather than calling `String#isWellFormed`: that is ES2024 and
 * this module is compiled against an older lib for the mobile and desktop
 * clients that import it.
 */
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
  | {
      ok: true;
      /** Durable gateway identity. Dial tickets and relay hints are refreshable addresses only. */
      gatewayId: string;
      deviceId: string;
      desktopName: string;
    }
  | { ok: false; error: "invalid_code" | "expired_code" | "bad_request" };

/** The JSON the desktop encodes into the "Connect phone" QR. */
export interface PairQrPayload {
  v: 1;
  kind: "centraid-pair";
  /** iroh EndpointTicket (base32) — carries the desktop's EndpointId + dial info. */
  ticket: string;
  /** One-time pairing code, consumed on first successful pair. */
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

/** Encode a header frame: u32 BE length + UTF-8 JSON. */
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

// Async stream readers are integration-owned (#532 property suite covers
// encodeHeaderFrame / parsePairQrPayload / sanitizeHeaders only).
// Stryker disable all
/** Read one header frame. Throws on oversized or malformed frames. */
export async function readHeaderFrame<T>(recv: FrameRecv): Promise<T> {
  const lenBytes = Buffer.from(await recv.readExact(4));
  const len = lenBytes.readUInt32BE(0);
  if (len === 0 || len > MAX_HEADER_FRAME_BYTES) {
    throw new Error(`tunnel: header frame length ${len} out of bounds`);
  }
  const jsonBytes = Buffer.from(await recv.readExact(len));
  return JSON.parse(jsonBytes.toString("utf8")) as T;
}

/**
 * Read body bytes until stream FIN, invoking `onChunk` per chunk.
 * iroh-js signals EOF with an empty read (validated in the Phase 0 spike).
 */
export async function readBody(
  recv: ChunkRecv,
  onChunk: (chunk: Buffer) => void | Promise<void>,
  maxBytes = Number.POSITIVE_INFINITY
): Promise<void> {
  let total = 0;
  // Frame delivery is an ordered stream: backpressure from `onChunk` must
  // settle before asking the transport for the next bytes.
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

/** Read an entire body into one buffer (request side; bounded). */
export async function readBodyToEnd(
  recv: ChunkRecv,
  maxBytes = MAX_REQUEST_BODY_BYTES
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await readBody(recv, (c) => void chunks.push(c), maxBytes);
  return Buffer.concat(chunks);
}

/** Hop-by-hop headers that must not cross the tunnel (RFC 9110 §7.6.1). */
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
