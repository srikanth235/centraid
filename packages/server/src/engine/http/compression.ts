/*
 * Response compression for the gateway HTTP layer (#404, "Mobile fast
 * path"). One negotiator in front of the JSON responses the gateway serves —
 * app RPC results, `_describe`, and the conversation ledger.
 *
 * Wire safety across every transport that consumes these responses:
 *
 *   - Desktop Electron client and the mobile native proxy speak real HTTP
 *     stacks: they send `Accept-Encoding` and transparently *decode*
 *     `Content-Encoding` for us. Nothing to do.
 *
 *   - The PWA service worker (apps/web/public/sw.js `tunnel()`) and the direct
 *     browser transport (apps/web/src/iroh-transport.ts `irohFetch`) rebuild a
 *     `Response` in JS from opaque tunnel bytes. A browser does NOT run
 *     Content-Encoding decoding on a `new Response(...)` synthesized inside a
 *     service worker / page — the header is treated as inert metadata and the
 *     body is delivered as-is. So compressing on that path would ship
 *     still-compressed bytes to the page and break it.
 *
 * The gate that keeps those paths safe is the ordinary content-negotiation
 * contract: **we only compress when the request explicitly offers
 * `Accept-Encoding`.** `Accept-Encoding` is a browser-managed forbidden
 * header — it is never present in the `Headers` a service worker or a page
 * `Request` can read, so those transports never forward it, {@link
 * negotiateEncoding} returns `null`, and they receive raw bytes. Real HTTP
 * stacks add it and decode the result. No custom gate header is needed.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import zlib from "node:zlib";

/**
 * Below this raw-body size, compression's header + framing overhead and CPU
 * cost aren't worth the shave — most tool JSON replies land here and ship
 * uncompressed.
 */
export const MIN_COMPRESS_BYTES = 1024;

export type Encoding = "br" | "gzip";

/**
 * Brotli beats gzip on ratio for the same wall-clock at a comparable quality,
 * so it's preferred whenever the client offers it. Both are decoded natively
 * by every real HTTP stack we serve.
 *
 * Parses the `q`-weighted `Accept-Encoding` list: an explicit `q=0`
 * disqualifies a coding (RFC 9110 §12.5.3). Returns `null` when neither br nor
 * gzip is acceptable — including the empty/absent header, which is exactly how
 * the service-worker and browser-transport paths opt out (see the file
 * header).
 */
export function negotiateEncoding(
  header: string | string[] | undefined
): Encoding | null {
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (!raw) return null;
  const q = new Map<string, number>();
  for (const part of raw.split(",")) {
    const [nameRaw, ...params] = part.trim().split(";");
    const name = nameRaw?.trim().toLowerCase();
    if (!name) continue;
    let weight = 1;
    for (const p of params) {
      const m = /^\s*q=(?<weight>[0-9.]+)\s*$/iu.exec(p);
      const parsed = m?.groups?.weight;
      if (parsed !== undefined) weight = Number(parsed);
    }
    q.set(name, Number.isNaN(weight) ? 0 : weight);
  }
  const br = q.get("br") ?? q.get("*");
  if (br !== undefined && br > 0) return "br";
  const gzip = q.get("gzip") ?? q.get("*");
  if (gzip !== undefined && gzip > 0) return "gzip";
  return null;
}

export interface CompressQuality {
  /** Brotli quality 0-11 (higher = smaller/slower). */
  brotli: number;
  /** gzip level 0-9. */
  gzip: number;
}

/**
 * Dynamic responses (tool JSON) are compressed on the request's hot path, so
 * favour speed: mid brotli / mid gzip still land most of the ratio. Every
 * body the gateway compresses is dynamic (#799): there is no cached static
 * asset plane spending for ratio instead.
 */
export const DYNAMIC_QUALITY: CompressQuality = { brotli: 4, gzip: 6 };

/** Compress on libuv's worker pool so large payloads never stall the event loop. */
export function compress(
  buf: Buffer,
  encoding: Encoding,
  quality: CompressQuality
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const done = (error: Error | null, result: Buffer): void => {
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    };
    if (encoding === "br") {
      zlib.brotliCompress(
        buf,
        {
          params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: quality.brotli,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
          },
        },
        done
      );
      return;
    }
    zlib.gzip(buf, { level: quality.gzip }, done);
  });
}

/**
 * Send a JSON body, compressing (dynamic quality) when the client offers an
 * encoding and the payload clears {@link MIN_COMPRESS_BYTES}. `Vary:
 * Accept-Encoding` is always set so an intermediary caches per encoding.
 * Node fills `Content-Length` from the buffer we `end()` — no stale length.
 */
export async function sendJsonNegotiated(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: unknown
): Promise<true> {
  const raw = Buffer.from(JSON.stringify(body), "utf8");
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Vary", "Accept-Encoding");
  const encoding =
    raw.length >= MIN_COMPRESS_BYTES
      ? negotiateEncoding(req.headers["accept-encoding"])
      : null;
  if (!encoding) {
    res.end(raw);
    return true;
  }
  res.setHeader("Content-Encoding", encoding);
  res.end(await compress(raw, encoding, DYNAMIC_QUALITY));
  return true;
}
