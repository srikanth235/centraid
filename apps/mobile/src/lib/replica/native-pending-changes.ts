// THE PENDING SHEET, DERIVED FROM THE OUTBOX (#996, R23; #922 G5).
//
// What the member sees when they ask "what have I saved that has not landed
// yet" — and every row of it is read from `seat_outbox`, which is a table in
// the seat's own file.
//
// THERE IS NO SECOND STORE OF WHAT TO TELL THEM. The phone used to keep an
// `replica_intent_attention` table beside its outbox for refusals it wanted to
// keep showing after the intent was gone. It is not needed and it was a second
// opinion: a refusal is RETAINED in the outbox by construction — `denied`,
// `failed`, `conflict`, `expired` and `parked` are states an intent SITS in,
// not states it is removed by (`retainedAttention`) — so the sheet is the
// queue, and dismissing a row is discarding the intent it is about.
//
// THE HELD BADGE IS COMPUTED HERE, NOT ON THE GATEWAY. A dependent that nothing
// is wrong with, waiting behind an earlier change, has to read correctly in
// airplane mode — where no verdict exists and will not for hours (R23).

import {
  chainBadgeCopy,
  chainHolds,
  reconstructPendingProjection,
} from "@centraid/client/replica/native";
import type {
  IntentQueue,
  IntentState,
  OptimisticMutation,
  ReplicaIntent,
} from "@centraid/client/replica/native";

import { publishPendingContentRefs } from "./pending-content-refs";

export interface NativePendingChange {
  intentId: string;
  /** The intent's own state IS the verdict (#922 G5). */
  status: Exclude<IntentState, "executed">;
  appId: string;
  action: string;
  reason?: string;
  attempts: number;
  enqueuedAt?: string;
  /** Conflict only: the two versions the overlay copy prints. */
  expectedVersion?: number;
  actualVersion?: number;
  /** A dependent nothing is wrong with, held behind an earlier change (R23). */
  heldBadge?: string;
}

/** The overlay a restart rebuilds, in outbox order (R23). */
export async function nativePendingProjection(
  queue: IntentQueue
): Promise<OptimisticMutation[]> {
  return reconstructPendingProjection(await queue.pending());
}

/** `attempts` and `enqueuedAt` are what separate "sending" from "stuck". */
export async function nativePendingChanges(
  queue: IntentQueue
): Promise<NativePendingChange[]> {
  const pending = await queue.pending();
  const badges = new Map(
    chainHolds(pending).map((hold) => [hold.intentId, chainBadgeCopy(hold)])
  );
  return pending.flatMap((intent) =>
    intent.state === "executed"
      ? []
      : [
          row(
            intent as ReplicaIntent & { state: NativePendingChange["status"] },
            badges
          ),
        ]
  );
}

function row(
  intent: ReplicaIntent & { state: NativePendingChange["status"] },
  badges: ReadonlyMap<string, string>
): NativePendingChange {
  return {
    intentId: intent.intentId,
    status: intent.state,
    appId: intent.appId,
    action: intent.action,
    ...(intent.reason ? { reason: intent.reason } : {}),
    attempts: intent.attempts,
    ...(intent.enqueuedAt ? { enqueuedAt: intent.enqueuedAt } : {}),
    ...(intent.conflict
      ? {
          expectedVersion: intent.conflict.expectedVersion,
          actualVersion: intent.conflict.actualVersion,
        }
      : {}),
    ...(badges.has(intent.intentId)
      ? { heldBadge: badges.get(intent.intentId)! }
      : {}),
  };
}

/**
 * Tell the byte store which content ids this queue still needs (R25).
 *
 * Pushed rather than pulled: the eviction sweep is synchronous and the outbox
 * is not, so the seat publishes on every move of the queue and the sweep reads
 * the last publication. A store that cannot be read protects nothing NEW; the
 * previous answer stands, which over-keeps rather than over-evicts.
 */
export async function publishQueueContentRefs(
  queue: IntentQueue
): Promise<void> {
  try {
    publishPendingContentRefs(await queue.pending());
  } catch {
    /* The previous publication stands. */
  }
}
