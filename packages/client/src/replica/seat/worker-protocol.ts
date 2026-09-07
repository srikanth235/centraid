// THE SEAT WORKER'S WIRE (#996, wave 2).
//
// The applier is a loop over `INSERT … ON CONFLICT DO UPDATE` that can run for
// hundreds of thousands of rows on a catch-up. On the JS thread that is a
// frozen shell; in a worker it is a progress line. So the boundary is here,
// and it is deliberately COARSE: one message per PAGE, not per row or per
// commit. A per-row boundary would spend more time in `postMessage` than in
// SQLite, and a per-commit one would put the transaction boundary — the thing
// the whole atomicity argument rests on — under the scheduler's control.
//
// CHANGE NOTIFICATIONS GO THE OTHER WAY UNSOLICITED. A page lands, and the
// shell has to re-read the tables it touched. Answering the apply call is not
// enough: a seat also applies while nobody is waiting on it.

import type { SeatLogPageWire } from "@centraid/core/protocol";

import type { SeatChangeNotice } from "./applier.js";
import type {
  SeatBootstrapProgress,
  SeatBootstrapResult,
} from "./bootstrap.js";
import type { SeatBindValue } from "./driver.js";
import type { SeatReadOverlay } from "./read-overlay.js";
import type { SeatState } from "./state.js";

export interface SeatWorkerOpenOptions {
  readonly vaultId: string;
  /** Absolute, namespaced by vault — the same rule the old worker enforces. */
  readonly dbName: string;
  /** The "Keep an offline copy" switch (R9): false means remote-only. */
  readonly remember: boolean;
}

export interface SeatWorkerBootstrapOptions {
  readonly vaultId: string;
  /** Where the snapshot door lives, absolute or origin-relative. */
  readonly snapshotUrl: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly expansion?: number;
}

export interface SeatWorkerApplyOptions {
  readonly page: SeatLogPageWire;
  readonly deferOverThreshold?: boolean;
}

export interface SeatWorkerQuery {
  readonly sql: string;
  readonly bind?: readonly SeatBindValue[];
  /**
   * Draw the outbox's pending rows over the answer (#996, R23–R25). Absent is
   * the CANONICAL read — what this file holds, and nothing the gateway has not
   * seen. A list a member reads their own writes from passes it; a read that
   * is measuring the file (a count, a parity check) must not.
   */
  readonly overlay?: SeatReadOverlay;
}

export type SeatWorkerRequest =
  | { id: number; op: "open"; payload: SeatWorkerOpenOptions }
  | { id: number; op: "bootstrap"; payload: SeatWorkerBootstrapOptions }
  | { id: number; op: "state"; payload: undefined }
  | { id: number; op: "apply"; payload: SeatWorkerApplyOptions }
  | { id: number; op: "query"; payload: SeatWorkerQuery }
  | { id: number; op: "close"; payload: undefined };

export interface SeatWorkerResults {
  open: SeatState | undefined;
  bootstrap: SeatBootstrapResult;
  state: SeatState | undefined;
  apply: SeatApplySummary;
  query: object[];
  close: undefined;
}

/** What the shell is told about a page, minus the driver-side detail. */
export interface SeatApplySummary extends SeatChangeNotice {
  readonly applied: number;
  readonly duplicate: number;
  readonly deferred: number;
  readonly ddl: number;
  readonly deferredFrom: number | undefined;
  readonly gatewayWatermark: number;
}

export interface SerializedSeatError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly reason?: string;
  readonly recovery?: string;
}

export type SeatWorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: SerializedSeatError }
  | { event: "change"; notice: SeatChangeNotice }
  | { event: "bootstrap-progress"; progress: SeatBootstrapProgress };

export function serializeSeatError(error: unknown): SerializedSeatError {
  if (!(error instanceof Error))
    return { name: "Error", message: String(error) };
  const shaped = error as Error & {
    code?: string;
    reason?: string;
    recovery?: string;
  };
  return {
    name: error.name,
    message: error.message,
    ...(shaped.code ? { code: shaped.code } : {}),
    ...(shaped.reason ? { reason: shaped.reason } : {}),
    ...(shaped.recovery ? { recovery: shaped.recovery } : {}),
  };
}
