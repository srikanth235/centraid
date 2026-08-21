/**
 * A seeded chaos shim over a REAL iroh connection (issue #842 W3.1).
 *
 * The connection underneath is a live QUIC transport dialled by
 * `createTunnelClient` and served by `startGatewayEndpoint` — nothing here
 * simulates the transport. What this wrapper adds is the adversity the
 * loopback never supplies, applied at the seam where a QUIC transport
 * genuinely surfaces network trouble to the product: the stream.
 *
 * See `network-faults.ts` for why loss and reordering are NOT injected here.
 * Everything below is a shape a healthy QUIC connection really does produce —
 * delay, jitter, an arrival split, a starved direction, a reset stream, a
 * dropped connection.
 *
 * All timing is derived from a seeded generator and is never asserted on: the
 * lane asserts OUTCOMES (what is in the vault, what is in the queue), so a
 * loaded runner changes how long a case takes and never whether it passes.
 */

import type { SeededRandom } from "@centraid/test-kit/random";

import type {
  BiStream,
  Connection,
  RecvStream,
  SendStream,
} from "../../packages/tunnel/src/iroh.js";
import type { NetworkFaultId } from "./network-faults.js";

/** Wire-level accounting — the bounded-resource meter the lane asserts on. */
export interface ChaosMeter {
  streams: number;
  sentBytes: number;
  receivedBytes: number;
}

/**
 * A catalog fault, or `recovered` — the healthy link a retry rides once the
 * network comes back. `recovered` shapes nothing, which is what makes
 * "converges once the network recovers" a claim about the product rather than
 * about the shim.
 */
export type ChaosFaultSetting = NetworkFaultId | "recovered";

export interface ChaosLinkOptions {
  readonly fault: ChaosFaultSetting;
  readonly rng: SeededRandom;
  /** Drop the live transport (connection-scoped faults only). */
  readonly onDrop: () => void;
}

/** Thrown by an injected fault, so a chaos failure is never a mystery. */
export class ChaosFaultError extends Error {
  constructor(
    readonly fault: ChaosFaultSetting,
    detail: string
  ) {
    super(`chaos[${fault}]: ${detail}`);
    this.name = "ChaosFaultError";
  }
}

/** A long healthy link: single-digit milliseconds, applied to every write. */
const LATENCY_MS = 2;
/** Jitter ceiling — a seeded draw in [0, MAX_JITTER_MS]. */
const MAX_JITTER_MS = 6;
/** Uplink budget under `asymmetric-bandwidth`: a small metered chunk per tick. */
const THROTTLED_CHUNK_BYTES = 24;
const THROTTLE_TICK_MS = 1;
/** Ceiling on the seeded fragment size under `fragment-coalesce`. */
const MAX_FRAGMENT_BYTES = 8;

/** Non-literal delay: a configurable pause, not a fixed sleep bet (#781). */
function pause(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The per-write delay this fault imposes, in milliseconds. */
function writeDelayMs(fault: ChaosFaultSetting, rng: SeededRandom): number {
  if (fault === "latency-uniform") return LATENCY_MS;
  if (fault === "jitter-burst") return rng.int(0, MAX_JITTER_MS);
  if (fault === "asymmetric-bandwidth") return THROTTLE_TICK_MS;
  return 0;
}

/** How this fault shapes one logical write into wire chunks. */
function chunksOf(
  buf: Array<number>,
  fault: ChaosFaultSetting,
  rng: SeededRandom
): Array<Array<number>> {
  if (buf.length === 0) return [buf];
  if (fault === "asymmetric-bandwidth") {
    const out: Array<Array<number>> = [];
    for (let at = 0; at < buf.length; at += THROTTLED_CHUNK_BYTES)
      out.push(buf.slice(at, at + THROTTLED_CHUNK_BYTES));
    return out;
  }
  if (fault === "fragment-coalesce") {
    const out: Array<Array<number>> = [];
    let at = 0;
    while (at < buf.length) {
      const size = rng.int(1, MAX_FRAGMENT_BYTES);
      out.push(buf.slice(at, at + size));
      at += size;
    }
    return out;
  }
  return [buf];
}

function chaosSend(
  send: SendStream,
  options: ChaosLinkOptions,
  meter: ChaosMeter
): SendStream {
  const { fault, rng } = options;
  // Per-STREAM write ordinal: write 1 is the header frame, write 2 the body.
  // `abort-mid-request` cuts the body, never the header, so the gateway reads
  // a well-formed request that then stops — the real shape of a dropped upload.
  let writes = 0;
  return {
    write: (buf) => send.write(buf),
    reset: (code) => send.reset(code),
    finish: () => send.finish(),
    writeAll: async (buf) => {
      writes += 1;
      if (fault === "abort-mid-request" && writes === 2) {
        const half = buf.slice(0, Math.max(1, Math.floor(buf.length / 2)));
        await send.writeAll(half);
        meter.sentBytes += half.length;
        await send.reset(1n);
        throw new ChaosFaultError(
          fault,
          `send stream reset after ${half.length}/${buf.length} body bytes`
        );
      }
      for (const chunk of chunksOf(buf, fault, rng)) {
        const ms = writeDelayMs(fault, rng);
        // Sequential by construction: a shaped write is an ordered stream, and
        // overlapping the pieces would defeat the shape being injected.
        // oxlint-disable-next-line no-await-in-loop -- one metered chunk at a time
        if (ms > 0) await pause(ms);
        // oxlint-disable-next-line no-await-in-loop -- one metered chunk at a time
        await send.writeAll(chunk);
        meter.sentBytes += chunk.length;
      }
    },
  };
}

function chaosRecv(
  recv: RecvStream,
  options: ChaosLinkOptions,
  meter: ChaosMeter
): RecvStream {
  const { fault, rng } = options;
  // `readExact` serves the response HEADER frame; `read` serves its body. The
  // drop lands between them ON PURPOSE: the header proves the gateway already
  // produced a status, so the write definitely landed, while the caller is
  // left with no outcome at all. That is the genuinely ambiguous retry.
  let dropped = false;
  return {
    stop: (code) => recv.stop(code),
    readExact: async (size) => {
      const ms = writeDelayMs(fault, rng);
      if (ms > 0) await pause(ms);
      const bytes = await recv.readExact(size);
      meter.receivedBytes += bytes.length;
      return bytes;
    },
    read: async (limit) => {
      if (fault === "disconnect-mid-response" && !dropped) {
        dropped = true;
        options.onDrop();
        throw new ChaosFaultError(
          fault,
          "connection dropped after the response header, before its body"
        );
      }
      const ms = writeDelayMs(fault, rng);
      if (ms > 0) await pause(ms);
      const bytes = await recv.read(limit);
      meter.receivedBytes += bytes.length;
      return bytes;
    },
  };
}

/**
 * Wrap a live connection so every stream it opens rides the named fault.
 * Endpoint-scoped faults (`endpoint-restart`, `address-rebind`) shape nothing
 * here — they are applied by the rig between attempts, to the endpoints
 * themselves — so this wrapper is a faithful pass-through for them.
 */
export function chaosConnection(
  connection: Connection,
  options: ChaosLinkOptions
): { connection: Connection; meter: ChaosMeter } {
  const meter: ChaosMeter = { streams: 0, sentBytes: 0, receivedBytes: 0 };
  const wrapped: Connection = {
    alpn: () => connection.alpn(),
    remoteId: () => connection.remoteId(),
    closed: () => connection.closed(),
    close: (code, reason) => connection.close(code, reason),
    stableId: () => connection.stableId(),
    rtt: () => connection.rtt(),
    paths: () => connection.paths(),
    acceptBi: () => connection.acceptBi(),
    openBi: async (): Promise<BiStream> => {
      const bi = await connection.openBi();
      meter.streams += 1;
      return {
        send: chaosSend(bi.send, options, meter),
        recv: chaosRecv(bi.recv, options, meter),
      };
    },
  };
  return { connection: wrapped, meter };
}
