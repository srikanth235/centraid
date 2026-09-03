import type { SeededRandom } from "@centraid/test-kit/random";

import type {
  BiStream,
  Connection,
  RecvStream,
  SendStream,
} from "../../packages/tunnel/src/iroh.js";
import type { NetworkFaultId } from "./network-faults.js";

export interface ChaosMeter {
  streams: number;
  sentBytes: number;
  receivedBytes: number;
}

export type ChaosFaultSetting = NetworkFaultId | "recovered";

export interface ChaosLinkOptions {
  readonly fault: ChaosFaultSetting;
  readonly rng: SeededRandom;
  readonly onDrop: () => void;
}

class ChaosFaultError extends Error {
  constructor(
    readonly fault: ChaosFaultSetting,
    detail: string
  ) {
    super(`chaos[${fault}]: ${detail}`);
    this.name = "ChaosFaultError";
  }
}

const LATENCY_MS = 2;
const MAX_JITTER_MS = 6;
const THROTTLED_CHUNK_BYTES = 24;
const THROTTLE_TICK_MS = 1;
const MAX_FRAGMENT_BYTES = 8;

function pause(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function writeDelayMs(fault: ChaosFaultSetting, rng: SeededRandom): number {
  if (fault === "latency-uniform") return LATENCY_MS;
  if (fault === "jitter-burst") return rng.int(0, MAX_JITTER_MS);
  if (fault === "asymmetric-bandwidth") return THROTTLE_TICK_MS;
  return 0;
}

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
