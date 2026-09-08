// THE MAIN THREAD'S END OF THE SEAT WORKER (#996, wave 2).
//
// A request/response map keyed by an incrementing id, plus two unsolicited
// events. Small on purpose: the interesting part of the boundary is in
// `worker-protocol.ts` (one message per PAGE), and everything else is
// plumbing that must not accumulate opinions.
//
// A WORKER THAT DIES REJECTS EVERY PENDING CALL. Otherwise a bootstrap that
// crashed leaves the shell awaiting a promise nothing will settle, which
// presents to the member as an app that has stopped rather than as an error
// it could retry.

import { ReplicaProtocolError } from "../replica-protocol-error.js";
import type { SeatChangeNotice } from "./applier.js";
import type {
  SeatBootstrapProgress,
  SeatBootstrapResult,
} from "./bootstrap.js";
import { SeatDriftError } from "./seat-drift-error.js";
import type { SeatState } from "./state.js";
import type {
  SeatApplySummary,
  SeatOutboxMethod,
  SeatWorkerApplyOptions,
  SeatWorkerBootstrapOptions,
  SeatWorkerOpenOptions,
  SeatWorkerQuery,
  SeatWorkerRequest,
  SeatWorkerResponse,
  SerializedSeatError,
} from "./worker-protocol.js";

export interface SeatWorkerLike {
  postMessage: (message: SeatWorkerRequest) => void;
  addEventListener: ((
    type: "message",
    listener: (event: MessageEvent<SeatWorkerResponse>) => void
  ) => void) &
    ((type: "error", listener: (event: ErrorEvent) => void) => void);
  removeEventListener: ((
    type: "message",
    listener: (event: MessageEvent<SeatWorkerResponse>) => void
  ) => void) &
    ((type: "error", listener: (event: ErrorEvent) => void) => void);
  terminate: () => void;
}

export type SeatWorkerFactory = () => SeatWorkerLike;

export interface SeatWorkerListeners {
  readonly onChange?: (notice: SeatChangeNotice) => void;
  readonly onBootstrapProgress?: (progress: SeatBootstrapProgress) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class SeatWorkerClient {
  #next = 1;
  #closed = false;
  readonly #pending = new Map<number, Pending>();

  constructor(
    private readonly worker: SeatWorkerLike,
    private readonly listeners: SeatWorkerListeners = {}
  ) {
    this.worker.addEventListener("message", this.onMessage);
    this.worker.addEventListener("error", this.onError);
  }

  private readonly onMessage = (
    event: MessageEvent<SeatWorkerResponse>
  ): void => {
    const message = event.data;
    if ("event" in message) {
      if (message.event === "change") this.listeners.onChange?.(message.notice);
      else this.listeners.onBootstrapProgress?.(message.progress);
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(reviveSeatError(message.error));
  };

  private readonly onError = (event: ErrorEvent): void => {
    this.fail(new Error(event.message || "seat worker failed"));
  };

  open(options: SeatWorkerOpenOptions): Promise<SeatState | undefined> {
    return this.call("open", options) as Promise<SeatState | undefined>;
  }

  bootstrap(options: SeatWorkerBootstrapOptions): Promise<SeatBootstrapResult> {
    return this.call("bootstrap", options) as Promise<SeatBootstrapResult>;
  }

  state(): Promise<SeatState | undefined> {
    return this.call("state", undefined) as Promise<SeatState | undefined>;
  }

  apply(options: SeatWorkerApplyOptions): Promise<SeatApplySummary> {
    return this.call("apply", options) as Promise<SeatApplySummary>;
  }

  /**
   * One read, forwarded whole.
   *
   * The request object rather than loose arguments because it carries the
   * OVERLAY (R23–R25), and an overlay that a signature can drop is an overlay
   * that gets dropped: the rows still come back, with the member's own pending
   * write missing and nothing to say so.
   */
  query<T extends object>(request: SeatWorkerQuery): Promise<T[]> {
    return this.call("query", request) as Promise<T[]>;
  }

  /**
   * One outbox method, forwarded (#996, R24).
   *
   * Typed loosely on purpose: the shape each method takes and answers is
   * `IntentRecordStore`'s, and `SeatWorkerOutbox` is where that contract is
   * stated. Restating it here would be a second copy to keep in step.
   */
  outbox<T>(method: SeatOutboxMethod, args: readonly unknown[]): Promise<T> {
    return this.call("outbox", { method, args }) as Promise<T>;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    try {
      await this.call("close", undefined);
    } catch {
      // A worker that has already gone is closed; the caller asked for the
      // end state, not for the journey.
    }
    this.fail(new Error("seat worker closed"));
  }

  private call(
    op: SeatWorkerRequest["op"],
    payload: unknown
  ): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("seat worker is closed"));
    const id = this.#next++;
    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      // `Worker.postMessage` deliberately has no `targetOrigin` parameter —
      // it is not `window.postMessage`, and there is no other origin to name.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      this.worker.postMessage({ id, op, payload } as SeatWorkerRequest);
    });
  }

  private fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.worker.removeEventListener("message", this.onMessage);
    this.worker.removeEventListener("error", this.onError);
    this.worker.terminate();
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

/**
 * A drift refusal must survive the worker boundary AS a drift refusal: the
 * shell's response to it is "re-bootstrap", and an anonymous `Error` with the
 * same message is one the shell would merely show.
 */
export function reviveSeatError(error: SerializedSeatError): Error {
  if (error.code === "seat_drift") {
    return new SeatDriftError(
      (error.reason as "epoch" | "schema-epoch" | "vault" | undefined) ??
        "schema-epoch",
      error.message
    );
  }
  // A QUEUE REFUSAL MUST SURVIVE AS A QUEUE REFUSAL (#996, R24). The outbox
  // now answers across this boundary (`SeatWorkerOutbox`), and every one of its
  // refusals — an id reused with another payload, a transition from a state
  // that does not allow it — is a `ReplicaProtocolError`. An anonymous `Error`
  // with the same message is one the queue would merely surface.
  if (error.code === "REPLICA_PROTOCOL_ERROR")
    return new ReplicaProtocolError(error.message);
  const revived = new Error(error.message);
  revived.name = error.name;
  return revived;
}

export function defaultSeatWorkerFactory(): SeatWorkerLike {
  return new Worker(new URL("seat-worker.js", import.meta.url), {
    type: "module",
    name: "centraid-seat",
  }) as unknown as SeatWorkerLike;
}
