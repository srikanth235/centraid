// THE SEAT CHANNEL WITH NO THREAD IN IT (#996, wave 4b).
//
// The phone's store is `SeatWorkerCore` in the app's own process: expo-sqlite's
// handle is native and synchronous, and React Native has no Worker to post to.
// So the channel is a call, and the ONLY thing it adds is the promise the loop
// is written against — plus the one property the message boundary was giving
// for free and would otherwise be silently lost:
//
// A SYNCHRONOUS THROW IS A REJECTION HERE. The worker channel serialises an
// error and rejects; a direct call would throw before the loop's `await`, past
// the `try` that recovers from `SeatDriftError` in a `.then` chain. Wrapping
// every call keeps drift recovery identical on both hosts.

import type {
  IntentRecordStore,
  NewStoredIntent,
} from "../intent-record-store.js";
import type { IntentOutcome, IntentState, ReplicaIntent } from "../types.js";
import type { SeatBootstrapResult } from "./bootstrap.js";
import type { SeatChannel } from "./seat-channel.js";
import type { SeatState } from "./state.js";
import type { SeatWorkerCore } from "./worker-core.js";
import type {
  SeatApplySummary,
  SeatWorkerApplyOptions,
  SeatWorkerBootstrapOptions,
  SeatWorkerOpenOptions,
  SeatWorkerQuery,
} from "./worker-protocol.js";

export function inProcessSeatChannel(core: SeatWorkerCore): SeatChannel {
  const call = async <T>(run: () => T | Promise<T>): Promise<T> => run();
  return {
    open: (options: SeatWorkerOpenOptions): Promise<SeatState | undefined> =>
      call(() => core.open(options)),
    // NO THREAD, BUT A STABLE FACE. The store is in this process and shares the
    // handle the applier writes through, which is exactly the arrangement R24
    // asks for — but the HANDLE is not stable: a bootstrap replaces the file,
    // so the core closes one driver and adopts another and re-creates the store
    // over it. A caller that captured the store once — the queue does, at
    // construction — would go on asking a closed database ("database is not
    // open") for the rest of the process. So what is handed out is a face that
    // resolves `core.outbox()` PER CALL. The browser gets this for free: its
    // `SeatWorkerOutbox` is a proxy over the wire and every call re-arrives.
    outbox: () => currentOutbox(core),
    bootstrap: (
      options: SeatWorkerBootstrapOptions
    ): Promise<SeatBootstrapResult> => call(() => core.bootstrap(options)),
    state: (): Promise<SeatState | undefined> => call(() => core.state()),
    apply: (options: SeatWorkerApplyOptions): Promise<SeatApplySummary> =>
      call(() => core.apply(options)),
    query: <T extends object>(request: SeatWorkerQuery): Promise<T[]> =>
      call(() => core.query(request) as T[]),
    purge: (): Promise<void> => call(() => core.purge()),
    close: (): Promise<void> => call(() => core.close()),
  };
}

/**
 * The outbox by reference rather than by value: one object whose every method
 * asks the core for the store over the driver it holds NOW.
 */
function currentOutbox(core: SeatWorkerCore): IntentRecordStore {
  return {
    get settlesByCommitSeq(): boolean | undefined {
      return core.outbox().settlesByCommitSeq;
    },
    add: (intent: NewStoredIntent): Promise<ReplicaIntent> =>
      core.outbox().add(intent),
    get: (intentId: string): Promise<ReplicaIntent | undefined> =>
      core.outbox().get(intentId),
    list: (states?: readonly IntentState[]): Promise<ReplicaIntent[]> =>
      core.outbox().list(states),
    claimNext: (): Promise<ReplicaIntent | undefined> =>
      core.outbox().claimNext(),
    transition: (
      intentId: string,
      allowed: readonly IntentState[],
      patch: Partial<ReplicaIntent>
    ): Promise<ReplicaIntent> =>
      core.outbox().transition(intentId, allowed, patch),
    settle: (
      intentId: string,
      allowed: readonly IntentState[],
      patch: Partial<ReplicaIntent>
    ): Promise<ReplicaIntent> => core.outbox().settle(intentId, allowed, patch),
    listSettled: (limit?: number): Promise<IntentOutcome[]> =>
      core.outbox().listSettled(limit),
    clear: (): Promise<void> => core.outbox().clear(),
    close: (): void => core.outbox().close(),
    destroy: (): Promise<void> => core.outbox().destroy(),
  };
}
