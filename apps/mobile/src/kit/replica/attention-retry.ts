// Re-issuing a denied/conflicted/failed write from its attention row
// (issue #738), pure enough to test without a renderer — ReplicaStatusBar
// only has to call this and hand the result to `session.writeTo`.
//
// Mirrors the web seat's contract (`packages/blueprints/apps/tasks/logic.ts`
// `retryPending`): `pendingModel.takeForRetry` → a FRESH intent id → the
// app's own write wrapper. Mobile has no per-app `PendingOverlayModel`
// instance to take the retry FROM (the sync-status sheet reads the durable
// outbox directly — see ReplicaStatusBar's module doc for why); this module
// is the mobile-side equivalent of "the app's own write wrapper" instead,
// built once and shared by every app's attention row rather than
// per-screen. It never mints or carries an intent id itself — omitting one
// from the returned write input is what makes `NativeReplicaSession.write`
// mint a fresh one (the old id's payload hash is bound to the attempt that
// failed; reusing it would dedupe onto that failure).

import type { ReplicaValue } from "@centraid/client/replica/native";

import type { NativeOptimisticProjection } from "../../lib/replica/native-session";
import { PENDING_DECLARATIONS } from "./pending-declarations";
import { pendingProjector } from "./pending-rows";

/** The attention-row fields a retry needs. */
export interface RetryableAttention {
  appId: string;
  action: string;
  input?: Record<string, unknown>;
}

export interface AttentionRetryWrite {
  action: string;
  input: ReplicaValue;
  optimistic?: NativeOptimisticProjection;
}

/**
 * The write to re-issue for one attention row. Routes through the same
 * `pendingProjector` a screen's own write path uses, so the retried write
 * gets its pending row back on whichever app declares a projection for the
 * action; an app with no declaration (or an action it never declared) still
 * retries, it just renders no optimistic row until the next read.
 */
export function attentionRetryWrite(
  item: RetryableAttention
): AttentionRetryWrite {
  const input = item.input ?? {};
  const declaration = PENDING_DECLARATIONS[item.appId];
  return {
    action: item.action,
    // The journal only ever holds an action's own object payload, never a
    // scalar or array (write-helpers.ts requires it); the declaration
    // narrows the same replica catalog types would if this went through
    // `session.write` directly.
    input: input as ReplicaValue,
    ...(declaration
      ? { optimistic: pendingProjector(declaration, item.action, input) }
      : {}),
  };
}
