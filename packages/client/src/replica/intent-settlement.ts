// SETTLEMENT: WHAT AN ANSWER DOES TO THE QUEUE (#996, R24; #929 G1).
//
// Split out of `intents.ts` when that file passed the source cap — the same
// move `packages/vault/src/replica/intent-chain.ts` made on the gateway side,
// for the same reason. The queue is a state machine over durable rows; this is
// the reading of an ANSWER against those rows, and the two had grown into one
// file.
//
// THE ONE RULE THAT ORGANISES ALL OF IT: an answer is the gateway's fact, an
// overlay is this seat's. `executed` says the commit happened; it does not say
// this seat has the rows. So an answer that names its commit position PARKS
// the intent at `awaiting-change`, and the applied cursor is what settles it
// — which is R24 in one sentence, and the reason there are two settle
// functions below rather than one.

import type { IntentRecordStore } from "./intent-record-store.js";
import { intentVerdict, OVERLAY_STATES } from "./intent-verdict.js";
import type {
  IntentOutcome,
  ReplicaBaseVersion,
  ReplicaIntent,
} from "./types.js";

/**
 * "Does this replica already hold origin version V of that row?" Only the seat
 * can answer; a seat that cannot is treated as holding nothing, so an answer
 * without a probe waits rather than clearing early.
 */
export type HeldVersionProbe = (version: ReplicaBaseVersion) => boolean;

/**
 * Intent transitions share one durable queue; preserve outcome order instead
 * of racing state reads and writes for the same optimistic overlay.
 */
export function applyInIntentOrder<T>(
  values: Iterable<T>,
  apply: (value: T) => void | PromiseLike<void>
): Promise<void> {
  return Array.from(values).reduce<Promise<void>>(
    (sequence, value) => sequence.then(() => apply(value)),
    Promise.resolve()
  );
}

function heldEverywhere(
  answered: readonly ReplicaBaseVersion[],
  holdsVersion: HeldVersionProbe | undefined
): boolean {
  if (!holdsVersion) return false;
  return answered.every((version) => holdsVersion(version));
}

/**
 * G1 (#929): an `executed` answer that names ORIGIN ROW VERSIONS settles the
 * pending row only once this replica HOLDS them. Until then the intent stays
 * `awaiting-change` — the state the outbox already has for "the gateway said
 * yes, the row has not arrived" — so the badge clears when the member can
 * actually see their own change, not one round trip earlier.
 *
 * `holdsVersion` is injected because only the seat can answer it: on an
 * audience it reads the subscription's shape lineage, and a seat that cannot
 * answer passes nothing and settles as before.
 */
export async function applyIntentOutcomes(
  store: IntentRecordStore,
  outcomes: IntentOutcome[],
  holdsVersion?: HeldVersionProbe
): Promise<ReplicaIntent[]> {
  const updated: ReplicaIntent[] = [];
  await applyInIntentOrder(outcomes, async (outcome) => {
    const existing = await store.get(outcome.intentId);
    if (!existing || !OVERLAY_STATES.has(existing.state)) return;
    // R24: an `executed` answer that names its COMMIT POSITION is held
    // until this seat's applied cursor reaches it. That is one number
    // compared against one number, and it supersedes the per-row version
    // question for a seat that holds the whole file — which is every seat
    // under R1. `settleAtCommitSeq` is the other half.
    if (outcome.status === "executed" && outcome.commitSeq !== undefined) {
      updated.push(
        await store.transition(outcome.intentId, [...OVERLAY_STATES], {
          state: "awaiting-change",
          commitSeq: outcome.commitSeq,
          reason: undefined,
        })
      );
      return;
    }
    if (
      outcome.status === "executed" &&
      outcome.answeredVersions &&
      outcome.answeredVersions.length > 0 &&
      !heldEverywhere(outcome.answeredVersions, holdsVersion)
    ) {
      updated.push(
        await store.transition(outcome.intentId, [...OVERLAY_STATES], {
          state: "awaiting-change",
          answeredVersions: outcome.answeredVersions,
          reason: undefined,
        })
      );
      return;
    }
    // A conflict is a state of its own, and a conflict whose BASE ROW IS
    // GONE is a third one (#922 G5): the member's remedy differs, so the
    // verdict must too. The outbox `state` column is unconstrained TEXT, so
    // widening the vocabulary needs no migration on either store.
    const verdict = intentVerdict(outcome);
    const patch = {
      ...verdict,
      reason: outcome.reason,
      output: outcome.output,
      ...(outcome.conflict ? { conflict: outcome.conflict } : {}),
      ...(outcome.waitingOn ? { waitingOn: outcome.waitingOn } : {}),
    };
    // Executed is the only settled state: the unchanged outbox contract
    // journals it and scrubs its input. Attention outcomes remain ordinary
    // outbox transitions, so their existing optimistic projection survives
    // restart without changing any store schema or implementation.
    updated.push(
      outcome.status === "executed"
        ? await store.settle(outcome.intentId, [...OVERLAY_STATES], patch)
        : await store.transition(outcome.intentId, [...OVERLAY_STATES], patch)
    );
  });
  return updated;
}

/**
 * Settle every answer this seat's applied cursor has now reached (#996,
 * R24).
 *
 * Called with the commit position the applier just committed — from inside
 * that transaction where the outbox shares the seat's file, so the overlay
 * and the rows it was drawn over become visible together. Where the two
 * stores are separate (the browser's IndexedDB outbox) it is called just
 * after, and the window is the price of that split.
 */
export async function settleIntentsAtCommitSeq(
  store: IntentRecordStore,
  cursorCommitSeq: number
): Promise<ReplicaIntent[]> {
  const waiting = await store.list(["awaiting-change"]);
  const settled: ReplicaIntent[] = [];
  await applyInIntentOrder(waiting, async (intent) => {
    if (intent.commitSeq === undefined) return;
    if (intent.commitSeq > cursorCommitSeq) return;
    settled.push(
      await store.settle(intent.intentId, ["awaiting-change"], {
        state: "executed",
      })
    );
  });
  return settled;
}

/**
 * Settle the answers this replica has now caught up to (G1). Called after a
 * change batch applies: an `awaiting-change` intent whose answered versions
 * have arrived is executed, and the outbox journals it as it always did.
 */
export async function settleAnsweredIntents(
  store: IntentRecordStore,
  holdsVersion: HeldVersionProbe
): Promise<ReplicaIntent[]> {
  const waiting = await store.list(["awaiting-change"]);
  const settled: ReplicaIntent[] = [];
  await applyInIntentOrder(waiting, async (intent) => {
    const answered = intent.answeredVersions ?? [];
    if (answered.length === 0) return;
    if (!heldEverywhere(answered, holdsVersion)) return;
    settled.push(
      await store.settle(intent.intentId, ["awaiting-change"], {
        state: "executed",
      })
    );
  });
  return settled;
}
