// GETTING THE QUEUE TO THE GATEWAY (#996, R23; #880).
//
// One intent at a time, in outbox order, and the order is the whole of it: a
// transport failure HOLDS THE HEAD, so nothing behind the write that failed is
// sent past it. That is what makes a chain of offline edits arrive as the
// member made them rather than as the network happened to allow.
//
// AND EVERY EXIT SETTLES ITS WRITER. A `write()` that is still awaiting an
// answer when the drain stops is an app that has stopped, not an error anyone
// sees — so each branch here says something: an outcome, a refusal, or the
// durable admission the intent already has.
//
// SEPARATE FROM THE SESSION because it is the one loop with a transport in it,
// and because both seats run the same one. What differs between them is what
// happens AROUND a failure — the phone backs off on its own schedule and the
// browser retries on a timer — so the loop takes its recovery as callbacks
// rather than growing a host opinion.

import type { IntentQueue } from "./intents.js";
import {
  errorMessage,
  isPermanentIntentRejection,
  QUEUED_RETRYING,
} from "./shell-outcomes.js";
import type { ReplicaWriteResult } from "./shell-outcomes.js";
import type { IntentOutcome, ReplicaIntent } from "./types.js";

export interface IntentDrainHost {
  readonly queue: IntentQueue;
  /**
   * Send one intent. Rejects for transport, refusal and authorization alike.
   *
   * `in-flight` is the gateway saying "accepted, not yet committed", which is
   * not an OUTCOME — nothing has settled — so it is not in `IntentOutcome`'s
   * union and the wire carries it beside one.
   */
  readonly send: (intent: ReplicaIntent) => Promise<{
    outcome:
      | IntentOutcome
      | { intentId: string; status: "in-flight"; reason?: string };
  }>;
  readonly closed: () => boolean;
  readonly online: () => boolean;
  /** True while the copy is being replaced; claims nothing new (R23). */
  readonly quiesced?: () => boolean;
  /** Hold the loop until every in-flight `write()` has registered its waiter. */
  readonly settleRegistrations: () => Promise<void>;
  readonly resolve: (intentId: string, result: ReplicaWriteResult) => void;
  readonly reject: (intentId: string, error: unknown) => void;
  readonly rejectAll: (error: unknown) => void;
  /** Settle everyone still waiting on their durable admission (#880). */
  readonly queueEveryoneWaiting: (reason: string) => void;
  /** A settled intent, so the session can invalidate what it touched. */
  readonly settled: (intent: ReplicaIntent) => void;
  /**
   * This seat's applied commit position, when it has one (#1014, R1).
   *
   * ACK AFTER DELTA IS THE SAME ANSWER. The commit an `executed` answer names
   * may already be in the file — the change feed does not wait for the HTTP
   * reply — and the applier's in-transaction hook only fires for a commit it
   * is APPLYING, so an intent parked on a position the cursor has already
   * passed would never be swept. Reading the cursor here closes that window;
   * a host with no cursor omits it and the applier's hook is the only path,
   * as before.
   */
  readonly appliedCommitSeq?: () => number | undefined;
  readonly isAuthorizationError: (error: unknown) => boolean;
  readonly onAuthorizationRevoked: () => void;
  readonly scheduleRetry: () => void;
  /** The gateway answered, or did not. Only the phone acts on it. */
  readonly onGatewayOutcome?: (reachable: boolean) => void;
}

/** Drain until the queue is empty, the session closes, or the head fails. */
export async function drainIntents(host: IntentDrainHost): Promise<void> {
  // A LOOP, NOT RECURSION (#1014, P23) — the same de-recursion `uploader.ts`
  // took for #659, for the same reason: `return drainIntents(host)` held every
  // earlier intent's promise alive until the last one settled, so a deep
  // backlog cost memory proportional to the QUEUE'S LENGTH rather than to the
  // intent in flight. One intent at a time is still the contract (R23); only
  // the stack the pass leaves behind changes.
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- the head is sent alone, by contract
    const step = await drainOne(host);
    if (step === "stop") return;
  }
}

async function drainOne(host: IntentDrainHost): Promise<"stop" | "continue"> {
  if (host.closed() || !host.online()) return "stop";
  await host.settleRegistrations();
  if (host.closed()) return "stop";
  if (!host.online()) {
    host.queueEveryoneWaiting("waiting for a connection");
    return "stop";
  }
  // QUIESCE, WHICH IS NOT A STOP (R23). While the copy is being replaced this
  // claims nothing new — an answer arriving mid-swap would be reconciled
  // against a file that is about to go — but an intent ALREADY SENDING keeps
  // its answer, which is why the check is here and not at the top of the flush.
  if (host.quiesced?.()) return "stop";
  let intent: ReplicaIntent | undefined;
  try {
    intent = await host.queue.claimNext();
  } catch (error) {
    host.rejectAll(error);
    return "stop";
  }
  if (!intent) return "stop";
  const claimed = intent;
  try {
    const { outcome } = await host.send(claimed);
    if (outcome.status === "executed" && outcome.commitSeq !== undefined) {
      // AN ANSWER THAT NAMES ITS COMMIT GOES THROUGH SETTLEMENT (#1014, R1).
      // This branch used to park by hand, which threw `outcome.commitSeq`
      // away — and `clearSeatOverlaysAtCommit` selects on exactly that
      // column, so the comment it carried ("the overlay clears when the
      // applier reaches the commit") described a mechanism the line above it
      // made impossible. The reading of an answer lives in ONE place now;
      // the drain hands `applyIntentOutcomes` the answer it was given, and
      // the store's own `settlesByCommitSeq` decides whether the position or
      // the #929 row versions are what this outbox waits on.
      await applyOutcome(host, outcome);
    } else if (
      outcome.status === "executed" ||
      outcome.status === "in-flight"
    ) {
      // NO POSITION TO WAIT ON. `in-flight` is "accepted, not yet committed",
      // and an `executed` without a position is a gateway older than wave 1.
      // Both park — but they park carrying whatever the answer DID name, so
      // `settleAnsweredIntents` can rescue them by row version (#929 G1);
      // otherwise the next send settles them from the retained outcome.
      // Clearing `reason` is R2: a `fetch failed` an earlier attempt wrote is
      // not what this send did, and it was still being shown under intents
      // that had since executed.
      await host.queue.awaitingChange(
        claimed.intentId,
        outcome.status === "executed" ? outcome.answeredVersions : undefined
      );
    } else {
      await applyOutcome(host, outcome as IntentOutcome);
    }
    await host.settleRegistrations();
    host.resolve(claimed.intentId, outcome);
    host.onGatewayOutcome?.(true);
    return "continue";
  } catch (error) {
    if (host.isAuthorizationError(error)) {
      await host.settleRegistrations();
      host.reject(claimed.intentId, error);
      host.onAuthorizationRevoked();
      return "stop";
    }
    if (host.closed()) return "stop";
    if (isPermanentIntentRejection(error)) {
      const outcome: IntentOutcome = {
        intentId: claimed.intentId,
        status: error.status === 403 ? "denied" : "failed",
        reason: error.message,
      };
      await applyOutcome(host, outcome);
      await host.settleRegistrations();
      host.resolve(claimed.intentId, outcome);
      return "continue";
    }
    host.onGatewayOutcome?.(false);
    // A SESSION THAT CLOSED MID-SEND WRITES NOTHING. Its store is a handle on a
    // file that is already shut, and recording a transport failure against it
    // would be the drain outliving the thing it drains. The intent stays
    // `sending`, which `recoverSending` puts back at the head on the next open.
    if (host.closed()) return "stop";
    await host.queue
      .transportFailed(claimed.intentId, errorMessage(error))
      .catch(() => undefined);
    await host.settleRegistrations();
    host.resolve(claimed.intentId, {
      intentId: claimed.intentId,
      status: "queued",
      reason: QUEUED_RETRYING,
    });
    host.queueEveryoneWaiting(QUEUED_RETRYING);
    host.scheduleRetry();
    return "stop";
  }
}

async function applyOutcome(
  host: IntentDrainHost,
  outcome: IntentOutcome
): Promise<void> {
  const [settled] = await host.queue.applyOutcomes([outcome]);
  if (!settled) return;
  host.settled(settled);
  await sweepPassedCommit(host, settled);
}

/**
 * The parked-behind-the-cursor case (#1014, R1). See `appliedCommitSeq`.
 */
async function sweepPassedCommit(
  host: IntentDrainHost,
  settled: ReplicaIntent
): Promise<void> {
  if (settled.state !== "awaiting-change") return;
  if (settled.commitSeq === undefined) return;
  const applied = host.appliedCommitSeq?.();
  if (applied === undefined || applied < settled.commitSeq) return;
  for (const swept of await host.queue.settleAtCommitSeq(applied))
    host.settled(swept);
}
