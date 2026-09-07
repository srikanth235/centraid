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
  bootstrap: (
    options: SeatWorkerBootstrapOptions
  ) => Promise<SeatBootstrapResult>;
  state: () => Promise<SeatState | undefined>;
  apply: (options: SeatWorkerApplyOptions) => Promise<SeatApplySummary>;
  query: <T extends object>(request: SeatWorkerQuery) => Promise<T[]>;
  close: () => Promise<void>;
}
