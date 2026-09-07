// THE PURE HALF OF THE PENDING SHEET'S DATA (#996).
//
// Split out of `pending-changes.ts` because that module imports `AppState` for
// its ticker, and a mapper from an outbox row to a sheet row has no business
// needing React Native to be loadable. A journey that runs the real session on
// node has to be able to ask "what would the sheet draw" without a device
// runtime under it.

import type { IntentState } from "@centraid/client/replica/native";

/**
 * Every state a row of this device's outbox can be in.
 *
 * It is `IntentState` and nothing more since #996 wave 3. It used to be that
 * union PLUS the placement outbox's own `in-flight`, because the phone had two
 * outboxes; the placement plane went with `crossVaultPlacements`, and one
 * outbox is one vocabulary. Closed on purpose either way: the pending
 * surface's copy switch is exhaustive over it, so a new state cannot reach a
 * member as a raw engine word.
 */
export type PendingChangeStatus = IntentState;

export interface PendingChange {
  id: string;
  /** The one vault this seat holds; drawn on the row so the sheet can name it. */
  vaultLabel: string;
  status: PendingChangeStatus;
  /** `${appId}: ${action}`; seats parse it, the sheet presents `action`. */
  label: string;
  appId?: string;
  action?: string;
  reason?: string;
  /** Transport attempts so far, and the first admission (ISO-8601): together
   *  they separate a slow row from a stuck one. */
  attempts?: number;
  enqueuedAt?: string;
  /** Conflict only, and both or neither: the versions the overlay copy prints. */
  expectedVersion?: number;
  actualVersion?: number;
  /**
   * A dependent held behind an earlier change, in the member's words (R23).
   * Present means nothing is wrong with this row — it is waiting, and it
   * releases on its own when the change in front of it lands.
   */
  heldBadge?: string;
  /**
   * True for a row the outbox still holds, so Retry and Discard can fire. An
   * attention remnant — the last trace of a write the outbox no longer has —
   * is false, and keeps only Dismiss.
   */
  retained: boolean;
}

/** One row of the session's own outbox answer (`native-session.ts`). */
export interface SessionPendingRow {
  intentId: string;
  status: PendingChangeStatus;
  appId: string;
  action: string;
  reason?: string;
  attempts?: number;
  enqueuedAt?: string;
  expectedVersion?: number;
  actualVersion?: number;
  heldBadge?: string;
}

/** What the ticker needs; `NativeReplicaSession` satisfies it directly. */
export interface PendingChangeSource {
  pendingChanges: () => Promise<SessionPendingRow[]>;
  scope: () => { label: string } | undefined;
}

/**
 * The session's outbox rows as the sheet draws them.
 *
 * `label` stays `${appId}: ${action}` because seats parse it for their own
 * rows (apps/tally/tally-view-model.ts); `appId` and `action` travel beside it
 * so the shell's own sheet can present the act in words instead. The conflict
 * versions, `attempts` and `enqueuedAt` travel with the row because a member
 * deciding between Retry and Discard needs all three (docs/mobile-offline.md).
 *
 * `retained` is the tell that separates a row the outbox still holds from an
 * attention remnant — the last trace of a write it no longer has. Only the
 * first can be retried or discarded, and only a retained row carries
 * `attempts`.
 */
export function toPendingChanges(
  rows: readonly SessionPendingRow[],
  vaultLabel: string
): PendingChange[] {
  return rows.map((row) => ({
    id: row.intentId,
    vaultLabel,
    status: row.status,
    label: `${row.appId}: ${row.action}`,
    appId: row.appId,
    action: row.action,
    ...(row.reason === undefined ? {} : { reason: row.reason }),
    ...(row.attempts === undefined ? {} : { attempts: row.attempts }),
    ...(row.enqueuedAt === undefined ? {} : { enqueuedAt: row.enqueuedAt }),
    ...(row.expectedVersion !== undefined && row.actualVersion !== undefined
      ? {
          expectedVersion: row.expectedVersion,
          actualVersion: row.actualVersion,
        }
      : {}),
    ...(row.heldBadge === undefined ? {} : { heldBadge: row.heldBadge }),
    retained: row.attempts !== undefined,
  }));
}
