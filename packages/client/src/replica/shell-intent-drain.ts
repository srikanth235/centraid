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
  readonly isAuthorizationError: (error: unknown) => boolean;
  readonly onAuthorizationRevoked: () => void;
  readonly scheduleRetry: () => void;
  /** The gateway answered, or did not. Only the phone acts on it. */
  readonly onGatewayOutcome?: (reachable: boolean) => void;
}

/** Drain until the queue is empty, the session closes, or the head fails. */
export async function drainIntents(host: IntentDrainHost): Promise<void> {
  if (host.closed() || !host.online()) return;
  await host.settleRegistrations();
  if (host.closed()) return;
  if (!host.online()) {
    host.queueEveryoneWaiting("waiting for a connection");
    return;
  }
  // QUIESCE, WHICH IS NOT A STOP (R23). While the copy is being replaced this
  // claims nothing new — an answer arriving mid-swap would be reconciled
  // against a file that is about to go — but an intent ALREADY SENDING keeps
  // its answer, which is why the check is here and not at the top of the flush.
  if (host.quiesced?.()) return;
  let intent: ReplicaIntent | undefined;
  try {
    intent = await host.queue.claimNext();
  } catch (error) {
    host.rejectAll(error);
    return;
  }
  if (!intent) return;
  const claimed = intent;
  try {
    const { outcome } = await host.send(claimed);
    if (outcome.status === "executed" || outcome.status === "in-flight") {
      // NOT SETTLED HERE (#996, R24). The gateway committed; the overlay clears
      // when the applier reaches the commit, inside its transaction.
      await host.queue.awaitingChange(claimed.intentId);
    } else {
      await applyOutcome(host, outcome as IntentOutcome);
    }
    await host.settleRegistrations();
    host.resolve(claimed.intentId, outcome);
    host.onGatewayOutcome?.(true);
    return drainIntents(host);
  } catch (error) {
    if (host.isAuthorizationError(error)) {
      await host.settleRegistrations();
      host.reject(claimed.intentId, error);
      host.onAuthorizationRevoked();
      return;
    }
    if (host.closed()) return;
    if (isPermanentIntentRejection(error)) {
      const outcome: IntentOutcome = {
        intentId: claimed.intentId,
        status: error.status === 403 ? "denied" : "failed",
        reason: error.message,
      };
      await applyOutcome(host, outcome);
      await host.settleRegistrations();
      host.resolve(claimed.intentId, outcome);
      return drainIntents(host);
    }
    host.onGatewayOutcome?.(false);
    // A SESSION THAT CLOSED MID-SEND WRITES NOTHING. Its store is a handle on a
    // file that is already shut, and recording a transport failure against it
    // would be the drain outliving the thing it drains. The intent stays
    // `sending`, which `recoverSending` puts back at the head on the next open.
    if (host.closed()) return;
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
  }
}

async function applyOutcome(
  host: IntentDrainHost,
  outcome: IntentOutcome
): Promise<void> {
  const [settled] = await host.queue.applyOutcomes([outcome]);
  if (settled) host.settled(settled);
}
