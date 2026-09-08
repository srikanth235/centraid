// WHAT A SEAT LOOP TALKS TO (#996, wave 4b).
//
// Five calls, and they are `SeatWorkerCore`'s own — because the store on the
// other side IS `SeatWorkerCore` on every host. What differs is the distance:
// the browser must keep an applier that walks hundreds of thousands of rows
// off the thread that paints, so its channel posts messages to a Worker; the
// phone's screens are not painted by the JS thread that would run it and its
// SQLite handle is native and synchronous, so its channel is a function call.
//
// TYPED AS A PORT RATHER THAN AS `SeatWorkerClient` for the same reason
// `SeatQueryPort` is: the client class is typed against `MessageEvent` and
// `ErrorEvent`, which do not exist in a React Native typecheck.

import type { IntentRecordStore } from "../intent-record-store.js";
import type { SeatBootstrapResult } from "./bootstrap.js";
import type { SeatState } from "./state.js";
import type {
  SeatApplySummary,
  SeatWorkerApplyOptions,
  SeatWorkerBootstrapOptions,
  SeatWorkerOpenOptions,
  SeatWorkerQuery,
} from "./worker-protocol.js";

export interface SeatChannel {
  open: (options: SeatWorkerOpenOptions) => Promise<SeatState | undefined>;
  /**
   * THE OUTBOX IN THIS SEAT'S FILE (#996, R24). Not a sixth call but a handle:
   * every method on it is a call, and the whole point of the store living here
   * is that an executed answer clears its overlay in the transaction that
   * carries its commit. The browser's is a proxy over the wire's `outbox` op;
   * the phone's is the store itself.
   */
  outbox: () => IntentRecordStore;
  bootstrap: (
    options: SeatWorkerBootstrapOptions
  ) => Promise<SeatBootstrapResult>;
  state: () => Promise<SeatState | undefined>;
  apply: (options: SeatWorkerApplyOptions) => Promise<SeatApplySummary>;
  query: <T extends object>(request: SeatWorkerQuery) => Promise<T[]>;
  /** Delete the seat's file (revocation, unpair, vault switch). */
  purge: () => Promise<void>;
  close: () => Promise<void>;
}
