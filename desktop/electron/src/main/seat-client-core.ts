/*
 * The seat socket's client, as pure arithmetic (#1020, D-1020-F2).
 *
 * No `net`, no `electron`: a byte sink goes in, frames come out, and the
 * request/response multiplexing is a map. That is the split the v0 desktop
 * enforces for every module with a platform import (census §F1 — "every file
 * with an `electron` import has a pure `-core.ts` twin"), and it is what lets
 * the framing be tested against the Rust side's own fixtures instead of against
 * a live socket.
 *
 * ## The frame
 *
 * `u32BE(length) ‖ channel ‖ payload`, `length` counting the channel byte.
 * Channel `0x00` is a `centraid.core.v1.Envelope` (protobuf, byte-identical to
 * what crosses iroh); channel `0x01` is one UTF-8 JSON message. Main speaks
 * only the local channel — see `desktop/README.md` for why.
 *
 * ## Why a reassembler and not "read a frame"
 *
 * A stream gives you whatever arrived. A 128 KiB blob chunk arrives as many
 * chunks, and two small replies arrive as one — so the decoder is a buffer that
 * yields zero or more complete frames per push, and the test feeds it one byte
 * at a time to prove it.
 */

/** A `centraid.core.v1.Envelope`. */
export const CHANNEL_CORE = 0x00;
/** One JSON local-plane message. */
export const CHANNEL_LOCAL = 0x01;

/** `crates/protocol`'s `MAX_FRAME_BYTES`. A larger length is a broken peer. */
export const MAX_FRAME_BYTES = 262_144;

/** The local plane's version. Exact equality with the sidecar's. */
export const LOCAL_PROTOCOL_VERSION = 1;

export interface Frame {
  channel: number;
  payload: Uint8Array;
}

/** Frame one payload for the wire. */
export function encodeFrame(channel: number, payload: Uint8Array): Uint8Array {
  const length = payload.length + 1;
  if (length > MAX_FRAME_BYTES) {
    throw new Error(`a ${length}-byte frame is over the protocol's ceiling`);
  }
  const out = new Uint8Array(4 + length);
  out[0] = (length >>> 24) & 0xff;
  out[1] = (length >>> 16) & 0xff;
  out[2] = (length >>> 8) & 0xff;
  out[3] = length & 0xff;
  out[4] = channel;
  out.set(payload, 5);
  return out;
}

/** Frame one JSON message on the local channel. */
export function encodeLocal(message: unknown): Uint8Array {
  return encodeFrame(
    CHANNEL_LOCAL,
    new TextEncoder().encode(JSON.stringify(message))
  );
}

/**
 * A stream reassembler. `push` returns the frames that completed; anything
 * partial is held.
 */
export function createFrameReader(): {
  push: (chunk: Uint8Array) => Frame[];
  pending: () => number;
} {
  let buffer = new Uint8Array(0);
  return {
    push(chunk) {
      const joined = new Uint8Array(buffer.length + chunk.length);
      joined.set(buffer, 0);
      joined.set(chunk, buffer.length);
      buffer = joined;
      const frames: Frame[] = [];
      for (;;) {
        if (buffer.length < 4) break;
        const length =
          // Unsigned: a `<<` on a byte with the high bit set would go negative.
          (((buffer[0] as number) << 24) >>> 0) +
          ((buffer[1] as number) << 16) +
          ((buffer[2] as number) << 8) +
          (buffer[3] as number);
        if (length < 1 || length > MAX_FRAME_BYTES) {
          throw new Error(
            `a ${length}-byte frame is not a frame this build reads`
          );
        }
        if (buffer.length < 4 + length) break;
        frames.push({
          channel: buffer[4] as number,
          payload: buffer.slice(5, 4 + length),
        });
        buffer = buffer.slice(4 + length);
      }
      return frames;
    },
    pending: () => buffer.length,
  };
}

/** What the seat said, decoded. */
export type SeatMessage = { t: string } & Record<string, unknown>;

export function decodeLocal(payload: Uint8Array): SeatMessage {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(payload));
  if (typeof parsed !== "object" || parsed === null || !("t" in parsed)) {
    throw new Error("a local frame with no `t`");
  }
  return parsed as SeatMessage;
}

/**
 * The request/response multiplexer.
 *
 * Ids are minted here, monotonic and never reused — the same rule the core
 * channel follows (`envelope.proto`), and what makes a late answer to a
 * cancelled request a no-op rather than somebody else's reply. Unsolicited
 * messages (`state`, `closing`) have no id and go to the listener.
 */
export function createMultiplexer(options: {
  send: (bytes: Uint8Array) => void;
  /** Messages that answer nobody: `state`, `closing`, `refused`. */
  onUnsolicited: (message: SeatMessage) => void;
}): {
  request: (message: Record<string, unknown>) => Promise<SeatMessage>;
  deliver: (message: SeatMessage) => void;
  /** Fail every request in flight. Called when the socket dies. */
  abort: (reason: string) => void;
  inFlight: () => number;
  nextId: () => number;
} {
  let next = 1;
  const waiting = new Map<
    number,
    { resolve: (message: SeatMessage) => void; reject: (error: Error) => void }
  >();
  return {
    request(message) {
      const id = next;
      next += 1;
      return new Promise<SeatMessage>((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        try {
          options.send(encodeLocal({ ...message, id }));
        } catch (error) {
          waiting.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    deliver(message) {
      const id = typeof message["id"] === "number" ? message["id"] : undefined;
      // A `state` carries the id of the SUBSCRIPTION, which is answered once
      // and then keeps arriving — so an id whose waiter is gone is not an
      // error, it is a later push on a settled subscription.
      const waiter = id === undefined ? undefined : waiting.get(id);
      if (!waiter) {
        options.onUnsolicited(message);
        return;
      }
      waiting.delete(id as number);
      if (message.t === "error" || message.t === "refused") {
        const code =
          typeof message["code"] === "string" ? message["code"] : "refused";
        const detail =
          typeof message["message"] === "string" ? message["message"] : "";
        const error = new Error(detail ? `${code}: ${detail}` : code);
        // The code is carried, not folded into the text: the shell branches on
        // `still-arriving` versus `unsatisfiable`, and a string match on a
        // sentence is how that branch breaks silently.
        (error as Error & { code?: string }).code = code;
        waiter.reject(error);
        return;
      }
      waiter.resolve(message);
    },
    abort(reason) {
      for (const [, waiter] of waiting) waiter.reject(new Error(reason));
      waiting.clear();
    },
    inFlight: () => waiting.size,
    nextId: () => next,
  };
}

/** The handshake message a shell sends. */
export function rendererHello(nonce: string): Record<string, unknown> {
  return {
    t: "hello",
    client: "renderer",
    nonce,
    protocol: LOCAL_PROTOCOL_VERSION,
  };
}

/**
 * Judge the seat's answer to our handshake.
 *
 * The shell refuses a seat whose local protocol is not this build's, for the
 * same reason the sidecar refuses the shell: they ship in one artifact, so a
 * mismatch means one of the two is a leftover from a half-finished update, and
 * carrying on would be reading a shape neither side agreed to.
 */
export function judgeHelloOk(message: SeatMessage): {
  ok: boolean;
  reason?: string;
  instance?: string;
  mode?: "replicated" | "thin";
} {
  if (message.t === "refused") {
    const detail =
      typeof message["message"] === "string"
        ? message["message"]
        : "the seat refused";
    return { ok: false, reason: detail };
  }
  if (message.t !== "hello_ok") {
    return {
      ok: false,
      reason: `the seat answered \`${message.t}\`, not a handshake`,
    };
  }
  if (message["protocol"] !== LOCAL_PROTOCOL_VERSION) {
    return {
      ok: false,
      reason:
        "the shell and the seat process are from different builds — reinstall Centraid",
    };
  }
  const mode = message["mode"];
  return {
    ok: true,
    instance:
      typeof message["instance"] === "string" ? message["instance"] : undefined,
    mode: mode === "thin" ? "thin" : "replicated",
  };
}
