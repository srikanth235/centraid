/*
 * The ACP client connection: one spawned harness process, driven over the
 * Agent Client Protocol by `@agentclientprotocol/sdk` (stable entrypoint).
 *
 * The SDK owns the wire: request/response correlation, id allocation, typed
 * `RequestError` codes, the method-not-found answer for capabilities we never
 * advertised, and teardown of pending work when the connection dies. This
 * module owns only what the SDK cannot know about — the child process (stdio,
 * stderr tail, spawn failure, exit) and the `Stream` the SDK reads and writes.
 *
 * The transport is built here rather than with the SDK's `ndJsonStream` for
 * two reasons, both behavioural:
 *   - writes must survive a closed pipe (`safeStdinWrite`), because a harness
 *     can die between "writable was true" and the write landing; and
 *   - a line that looks like a frame but is not one must FAIL the connection.
 *     `ndJsonStream` logs and drops such lines, and a dropped frame is how a
 *     turn hangs until the idle watchdog fires instead of reporting a fault.
 *
 * `session/update` is the one frame the SDK's client app never sees. Its
 * `ClientApp` installs a `zSessionNotification.parse` router ahead of every
 * user handler, and a notification the generated union rejects — a vendor
 * update variant, a `usage_update` without the required `used`/`size`, a plan
 * entry without `priority` — is discarded with a console error before any
 * handler runs. That is the silent-drop failure this change exists to remove,
 * and it would take the leniency ./stream-events.ts is built on with it. So
 * session updates are delivered straight from the transport, unparsed.
 *
 * A connection is owned by exactly one session actor for its life. The handler
 * SET is fixed at connect time; only the turn-local sink those handlers
 * forward to is attached and released (see `attach`). That is why there is no
 * handler-rebinding hook: a warm-reused process gets a new sink, never a new
 * protocol surface.
 */

import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import { CLIENT_METHODS, client, RequestError } from "@agentclientprotocol/sdk";
import type {
  AnyMessage,
  RequestPermissionResponse,
  Stream,
} from "@agentclientprotocol/sdk";

import { safeStdinWrite } from "./safe-stdin-write.js";

/** How much of the agent's stderr we keep for a failure message. */
const STDERR_TAIL_BYTES = 64 * 1024;

/**
 * A line the agent wrote that opened like a JSON-RPC frame but is not one.
 *
 * Surfaced as a connection failure (every pending request rejects with it)
 * rather than skipped, so a harness speaking a broken dialect fails loudly on
 * the turn it broke instead of stalling.
 */
export class AcpFrameError extends Error {
  constructor(line: string) {
    super(`acp agent wrote a malformed frame: ${line.slice(0, 500)}`);
    this.name = "AcpFrameError";
  }
}

/**
 * Turn-local answers to the agent's server→client traffic.
 *
 * `params` stay UNPARSED on purpose. The generated ACP schemas strip unknown
 * keys and reject unknown update variants, while the fleet of shipped
 * harnesses hangs vendor fields off `session/update` that our normalizers
 * deliberately read (see ./stream-events.ts, ./permissions.ts). The SDK still
 * validates the JSON-RPC envelope; interpreting the payload stays ours.
 */
export interface HarnessTurnSink {
  /**
   * An inbound request or notification arrived — never a response to one of
   * our own requests. Proof the agent is still working, which is what the
   * prompt idle watchdog keys off.
   */
  onFrame?: () => void;
  /**
   * Answer `session/request_permission`. Omitted (or no sink attached) means
   * the connection declines the request the way it declines any capability we
   * never advertised.
   */
  onPermissionRequest?: (params: unknown) => RequestPermissionResponse;
  /**
   * A `session/update` notification's `params`, delivered from the transport
   * (see the header note) and therefore never schema-filtered.
   */
  onSessionUpdate?: (params: unknown) => void;
}

export interface HarnessConnection {
  /**
   * Request/response against the agent. Rejects with the SDK's `RequestError`
   * (code preserved) when the agent answers with a JSON-RPC error, and with
   * the connection's close cause when it dies mid-flight.
   */
  request: <T = unknown>(method: string, params: unknown) => Promise<T>;
  /**
   * Fire-and-forget notification. Best-effort by contract: `session/cancel`
   * races the child's death, and a write onto a dying pipe is not itself a
   * turn failure.
   */
  notify: (method: string, params: unknown) => void;
  /**
   * Install the sink that answers this connection's server→client traffic for
   * one turn. Returns a release function; after release the connection
   * declines requests and drops notifications, so a parked process cannot
   * deliver a late frame into a finished turn's closures.
   */
  attach: (sink: HarnessTurnSink) => () => void;
  /** Resolves once the child has exited or failed to spawn. */
  readonly exited: Promise<void>;
  /**
   * Nothing can be sent any more — the child is gone, or the protocol
   * connection failed. Pending requests have already been rejected.
   */
  isClosed: () => boolean;
  /** A spawn-level failure (`child.on('error')`), if any. */
  spawnError: () => Error | undefined;
  /** Trailing stderr, for attaching to a failure message. */
  stderrTail: () => string;
}

/** Params reach the sink as the agent sent them — see `HarnessTurnSink`. */
const unparsed = (params: unknown): unknown => params;

/**
 * The death of the agent process, worded so the failure classifier reads it as
 * an exit rather than an unclassifiable transport error.
 */
const agentExited = (): Error => new Error("acp agent exited");

/**
 * Mirrors the SDK's own message guards. A line that fails this is reported,
 * not dropped: the SDK's connection layer would otherwise log and discard it,
 * leaving the turn waiting on a response that will never come.
 */
function isFrame(value: unknown): value is AnyMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const frame = value as Record<string, unknown>;
  if (frame.jsonrpc !== "2.0") return false;
  if (typeof frame.method === "string") return true;
  return "id" in frame && ("result" in frame || "error" in frame);
}

/**
 * The agent's stdout as a stream of frames the SDK connection reads. Non-frame
 * lines are ignored (a harness is free to print banners and progress on
 * stdout); a line that opens like a frame and is not one fails the stream;
 * `session/update` is handed to the sink here rather than forwarded.
 */
function frameStream(
  stdout: Readable,
  currentSink: () => HarnessTurnSink | undefined
): ReadableStream<AnyMessage> {
  return new ReadableStream<AnyMessage>({
    start(controller) {
      let buffer = "";
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        controller.error(error);
      };
      /** True when the frame was consumed here and must not reach the SDK. */
      const deliver = (frame: AnyMessage): boolean => {
        // Responses to our own requests do not count as liveness — only
        // traffic the agent originated does.
        if (!("method" in frame)) return false;
        const sink = currentSink();
        sink?.onFrame?.();
        if (frame.method !== CLIENT_METHODS.session_update) return false;
        sink?.onSessionUpdate?.(frame.params);
        return true;
      };
      stdout.setEncoding("utf8");
      stdout.on("data", (chunk: string) => {
        if (settled) return;
        buffer += chunk;
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line.startsWith("{")) {
            let parsed: unknown;
            try {
              // Typed translation, not a swallow: an unparseable frame becomes
              // `AcpFrameError` and kills the connection below.
              parsed = JSON.parse(line);
            } catch {
              fail(new AcpFrameError(line));
              return;
            }
            if (!isFrame(parsed)) {
              fail(new AcpFrameError(line));
              return;
            }
            if (!deliver(parsed)) controller.enqueue(parsed);
          }
          nl = buffer.indexOf("\n");
        }
      });
      // EOF on an agent's stdout is not a graceful end of stream: no answer to
      // a pending request will ever arrive. Closing the stream instead would
      // let the SDK reject those requests with its generic close message and
      // erase the cause `classifyAgentFailureDetail` keys off.
      stdout.on("end", () => fail(agentExited()));
    },
  });
}

/**
 * Wire a spawned agent's stdio up as an ACP peer. Listeners are attached
 * synchronously, so no frame emitted by a fast-starting agent is lost.
 */
export function connectHarness(
  child: ChildProcessByStdio<Writable, Readable, Readable>
): HarnessConnection {
  let sink: HarnessTurnSink | undefined;
  let stderrBuf = "";
  let processExited = false;
  let exitError: Error | undefined;

  const stream: Stream = {
    readable: frameStream(child.stdout, () => sink),
    writable: new WritableStream<AnyMessage>({
      write(message) {
        safeStdinWrite(child.stdin, JSON.stringify(message) + "\n");
      },
    }),
  };

  const connection = client({ name: "centraid" })
    .onRequest(
      CLIENT_METHODS.session_request_permission,
      // Requests carry no schema router, so `unparsed` really is the only
      // thing between the agent and ./permissions.ts.
      unparsed,
      (ctx): RequestPermissionResponse => {
        const answer = sink?.onPermissionRequest?.(ctx.params);
        if (!answer)
          throw RequestError.methodNotFound(
            CLIENT_METHODS.session_request_permission
          );
        return answer;
      }
    )
    .connect(stream);

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrBuf = (stderrBuf + chunk).slice(-STDERR_TAIL_BYTES);
  });

  const exited = new Promise<void>((resolve) => {
    child.on("error", (err) => {
      exitError = err;
      processExited = true;
      connection.close(err);
      resolve();
    });
    child.on("exit", () => {
      processExited = true;
      // Usually a no-op: stdout EOF has already failed the stream with the same
      // cause. It still matters for a child that exits while holding its pipes.
      connection.close(agentExited());
      resolve();
    });
  });

  return {
    request: <T = unknown>(method: string, params: unknown): Promise<T> =>
      connection.agent.request<T, unknown>(method, params),
    notify: (method, params) => {
      void connection.agent.notify<unknown>(method, params).catch(() => {
        // See `HarnessConnection.notify`: best-effort by contract.
      });
    },
    attach: (next) => {
      sink = next;
      return () => {
        if (sink === next) sink = undefined;
      };
    },
    exited,
    isClosed: () => processExited || connection.signal.aborted,
    spawnError: () => exitError,
    stderrTail: () => stderrBuf,
  };
}
