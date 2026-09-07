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
    bootstrap: (
      options: SeatWorkerBootstrapOptions
    ): Promise<SeatBootstrapResult> => call(() => core.bootstrap(options)),
    state: (): Promise<SeatState | undefined> => call(() => core.state()),
    apply: (options: SeatWorkerApplyOptions): Promise<SeatApplySummary> =>
      call(() => core.apply(options)),
    query: <T extends object>(request: SeatWorkerQuery): Promise<T[]> =>
      call(() => core.query(request) as T[]),
    close: (): Promise<void> => call(() => core.close()),
  };
}
