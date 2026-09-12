/*
 * The socket, held by main and by nobody else (#1020, D-1020-F2).
 *
 * `node:net` lives here; every decision lives in `seat-client-core.ts`. **The
 * renderer never opens this socket**: it reaches it through `invoke/on/off`,
 * which is the same three-function boundary v0 used for `ipcRenderer` and for
 * the same reason — a capability the renderer holds is a capability every
 * blueprint's JSX holds.
 */

import net from "node:net";

import {
  CHANNEL_LOCAL,
  createFrameReader,
  createMultiplexer,
  decodeLocal,
  encodeLocal,
  judgeHelloOk,
  rendererHello,
} from "./seat-client-core.js";
import type { SeatMessage } from "./seat-client-core.js";

export interface SeatConnection {
  /** Send a request and await its answer. */
  request: (message: Record<string, unknown>) => Promise<SeatMessage>;
  /** The nonce the seat accepted, echoed. */
  instance: string | undefined;
  mode: "replicated" | "thin";
  close: () => Promise<void>;
  /** Whether the socket is still up. */
  alive: () => boolean;
}

/**
 * The seat refused this shell, carrying its own sentence.
 *
 * One of the ten refusal codes the sidecar defines, each with its own sentence
 * — the shell shows the one it got, never "could not connect".
 */
export class SeatRefusalError extends Error {
  public override readonly name = "SeatRefusalError";
}

/**
 * Connect, handshake, and hand back a multiplexed connection.
 *
 * A refusal is a `SeatRefusal` carrying the seat's own sentence — the ten
 * refusal codes the sidecar defines each have their own, and the shell shows
 * the one it got rather than "could not connect".
 */
export async function connectSeat(input: {
  socketPath: string;
  nonce: string;
  onState: (state: unknown) => void;
  onClosing: (reason: string) => void;
  onDisconnect: (reason: string) => void;
  connectTimeoutMs?: number;
}): Promise<SeatConnection> {
  const socket = await openSocket(
    input.socketPath,
    input.connectTimeoutMs ?? 10_000
  );
  const reader = createFrameReader();
  let handshake: ((message: SeatMessage) => void) | undefined;
  let alive = true;

  const mux = createMultiplexer({
    send: (bytes) => {
      socket.write(bytes);
    },
    onUnsolicited: (message) => {
      if (message.t === "state") {
        input.onState(message["state"]);
        return;
      }
      if (message.t === "closing") {
        const reason =
          typeof message["reason"] === "string"
            ? message["reason"]
            : "the seat closed";
        input.onClosing(reason);
        return;
      }
      // A `refused` with no id answers the handshake, which has no id.
      handshake?.(message);
    },
  });

  socket.on("data", (chunk: Buffer) => {
    let frames;
    try {
      frames = reader.push(new Uint8Array(chunk));
    } catch (error) {
      // A frame this build cannot read is fatal to the stream, not to the
      // process: the same rule `crates/protocol`'s `is_fatal_to_the_stream`
      // states on the other side.
      socket.destroy();
      mux.abort(error instanceof Error ? error.message : String(error));
      return;
    }
    for (const frame of frames) {
      if (frame.channel !== CHANNEL_LOCAL) {
        // The core channel is for `centraid mcp` and native clients. Main does
        // not speak it, and a frame on it here is a bug in the seat rather
        // than something to guess at.
        continue;
      }
      const message = decodeLocal(frame.payload);
      if (handshake && (message.t === "hello_ok" || message.t === "refused")) {
        handshake(message);
        continue;
      }
      mux.deliver(message);
    }
  });

  const dead = (reason: string): void => {
    if (!alive) return;
    alive = false;
    mux.abort(reason);
    input.onDisconnect(reason);
  };
  socket.on("error", (error: Error) => dead(error.message));
  socket.on("close", () => dead("the seat socket closed"));

  const answered = new Promise<SeatMessage>((resolve, reject) => {
    handshake = resolve;
    const timer = setTimeout(
      () =>
        reject(new SeatRefusalError("the seat did not answer the handshake")),
      10_000
    );
    // Not unref'd: this deadline must fire, for the same reason v0's teardown
    // cap is not unref'd (census §F seam 2).
    void timer;
  });
  // Framed through the same encoder every other message uses, so the
  // handshake cannot be framed differently from the traffic that follows it.
  socket.write(encodeLocal(rendererHello(input.nonce)));
  const judged = judgeHelloOk(await answered);
  handshake = undefined;
  if (!judged.ok) {
    socket.destroy();
    throw new SeatRefusalError(judged.reason ?? "the seat refused this shell");
  }

  return {
    request: (message) => mux.request(message),
    instance: judged.instance,
    mode: judged.mode ?? "replicated",
    alive: () => alive,
    close: async () => {
      if (!alive) return;
      await new Promise<void>((resolve) => {
        socket.end(() => resolve());
      });
    },
  };
}

/**
 * Connect with a bounded wait.
 *
 * A socket path that exists but nothing is listening on gives `ECONNREFUSED`
 * immediately, which is the *stale file* case the sidecar's own probe handles;
 * a path that does not exist gives `ENOENT`. Both are fast, so the timeout is
 * only here for a listener that accepted and then went quiet.
 */
function openSocket(path: string, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new Error(
          `the seat socket at ${path} did not accept within ${timeoutMs}ms`
        )
      );
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      // Nagle off: every message here is small and latency-sensitive, and a
      // 40 ms coalescing delay on a local socket is a visible frame.
      socket.setNoDelay(true);
      resolve(socket);
    });
    socket.once("error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
