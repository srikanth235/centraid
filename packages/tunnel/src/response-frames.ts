/*
 * Writing one small JSON answer onto a tunnel stream.
 *
 * Kept out of gateway-endpoint.ts because the two planes disagree about what
 * a refusal IS. A device gets an `{error}` — it belongs to this gateway's
 * owner, and naming the fault is how the owner fixes it. A peer gets a
 * `{state}` — it is another gateway's protocol code, so a refusal must be a
 * move it can make sense of, and `not_found` must cover every reason at once
 * so a probe maps nothing (#726).
 */

import type { SendStream } from "./iroh.js";
import type { TunnelResponseHeader } from "./protocol.js";
import { encodeHeaderFrame } from "./protocol.js";

/**
 * Convert response bytes to the `Array<number>` the iroh `SendStream.writeAll`
 * binding requires. The native `Vec<u8>` parameter rejects a `Buffer` /
 * `Uint8Array` at runtime ("Failed to get Array length" — it validates
 * `Array.isArray`), so a copy-free write of the Buffer itself is not possible
 * through this binding; the conversion is an unavoidable single copy. A
 * preallocated loop is used over `Array.from(buf)` to skip the iterator
 * protocol on this per-chunk hot path. Compression (#404) is what
 * actually shrinks the byte volume crossing here.
 */
export function bytesToArray(buf: Buffer, out: number[] = []): Array<number> {
  out.length = buf.length;
  for (let i = 0; i < buf.length; i++) out[i] = buf[i]!;
  return out;
}

/** Header frame + JSON body + FIN. A dead stream is not an error to report. */
export async function respondFrame(
  send: SendStream,
  status: number,
  payload: Record<string, string>
): Promise<void> {
  try {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    await send.writeAll(
      encodeHeaderFrame({
        status,
        headers: {
          "content-type": "application/json",
          "content-length": String(body.length),
        },
      } satisfies TunnelResponseHeader)
    );
    await send.writeAll(bytesToArray(body));
    await send.finish();
  } catch {
    // Stream already gone.
  }
}

/** Device-lane refusal: names the fault to the owner's own device. */
export function respondError(
  send: SendStream,
  status: number,
  error: string
): Promise<void> {
  return respondFrame(send, status, { error });
}

/** Peer-lane refusal: a typed STATE, never an exception rendered as an answer. */
export function respondPeerState(
  send: SendStream,
  status: number,
  state: string
): Promise<void> {
  return respondFrame(send, status, { state });
}
