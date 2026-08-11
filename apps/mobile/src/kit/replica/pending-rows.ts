// Pending rows on the phone — without a second source of truth (issue #738).
//
// Read composition already puts every unsettled write's row in the list it
// belongs to (lib/replica/multi-vault-overlay.ts), so a screen never holds
// pending state. This module answers the other half — WHICH of the rows on
// screen are still waiting — by joining the durable outbox's projected row ids
// against the rows the query returned. Survival across a restart is therefore
// structural: both halves read the same outbox.
//
// Pure, like ./replica-status: the part that can be wrong is the part under
// test, and neither the join nor the copy needs a renderer to assert.
//
// The copy is the shared one both seats use (`pending-overlay.ts`), so the
// phone says exactly what the desktop says about the same write.

import {
  pendingChipLabel,
  pendingReasonCopy,
  pendingStatusFromIntentState,
  projectPendingMutations,
} from "@centraid/blueprints/apps/_shared/pending-overlay";
import type {
  PendingProjectionDeclaration,
  PendingWriteStatus,
} from "@centraid/blueprints/apps/_shared/pending-overlay";
import type { ReplicaRow } from "@centraid/client/replica/native";

import type {
  NativeOptimisticMutation,
  NativeOptimisticProjection,
} from "../../lib/replica/native-session";
import type { PendingChange } from "./pending-changes";

/** What a list row says about itself while its write is still unsettled. */
export interface PendingRowMark {
  intentId: string;
  status: PendingWriteStatus;
  /** The chip's one word. */
  label: string;
  /** Why it is still pending, in the shared refusal grammar. */
  reason: string;
}

/**
 * The `optimistic` argument a screen hands its session write: the app's
 * blueprint declaration projected against the intent id the session mints.
 * The session owns minting (a double tap coalesces onto one id), so the
 * projection is a function of that id rather than of a locally guessed one.
 */
export function pendingProjector(
  declaration: PendingProjectionDeclaration,
  action: string,
  input: Record<string, unknown>
): NativeOptimisticProjection {
  return (intentId) =>
    projectPendingMutations(declaration, action, input, intentId).map(
      (mutation) =>
        (mutation.op === "delete"
          ? mutation
          : {
              ...mutation,
              // Declarations are host-neutral, so they type values as unknown.
              // The replica validates every column and value against the app's
              // consented catalog before the write is admitted, which is the
              // boundary that owns the schema.
              values: mutation.values as ReplicaRow,
            }) satisfies NativeOptimisticMutation
    );
}

/** Row id → pending mark for one app, from the device-global outbox view. */
export function pendingRowMarks(
  pending: readonly PendingChange[],
  appId: string,
  online: boolean
): Map<string, PendingRowMark> {
  const marks = new Map<string, PendingRowMark>();
  for (const change of pending) {
    if (change.kind !== "replica" || change.appId !== appId) continue;
    const status = pendingStatusFromIntentState(change.status);
    // Settled writes that need attention keep their place in the sync-status
    // sheet, not on a row: the replica stopped overlaying them, so the row
    // they projected is no longer in the list to mark.
    if (!status || !change.rowIds) continue;
    const mark: PendingRowMark = {
      intentId: change.id,
      status,
      label: pendingChipLabel(status),
      reason: pendingReasonCopy(status, {
        ...(change.reason ? { reason: change.reason } : {}),
        online,
      }),
    };
    for (const rowId of change.rowIds) marks.set(rowId, mark);
  }
  return marks;
}
