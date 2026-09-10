import type { ReplicaValue } from "@centraid/client/replica/native";

import type { MobileReplicaSession } from "../replica/native-session";
import {
  cleanupDeviceDerivatives,
  contributeDeviceDerivatives,
} from "./derivatives-native";
import type { UploadQueue } from "./native-queue";

/** After this many failed replays a follow-up is quarantined, not retried (F4). */
const MAX_FOLLOWUP_ATTEMPTS = 5;

export interface FollowupReplaySummary {
  /** Records whose canonical mutation executed (or entered the outbox). */
  replayed: number;
  /** Records quarantined this pass after exhausting their attempts. */
  poisoned: number;
  /**
   * Records whose vault is not the one this session holds (#1014, P2), by
   * vault id. NOT a failure and NOT an attempt: the bytes are durable and the
   * write is waiting for the seat that owns the row, which is what the pending
   * surface reports as "waiting for <vault>".
   */
  waitingForVault: Readonly<Record<string, number>>;
}

/**
 * Finish every canonical mutation whose bytes have a durable casAck. A record
 * is removed only after `session.write` has either executed or entered the
 * replica intent outbox, so process death at any earlier point is recoverable.
 *
 * Each follow-up is isolated: one that cannot replay (a poisoned payload, a
 * gone derivative, a persistently rejecting write) counts an attempt and is
 * quarantined once it clearly stops being transient (F4) — it can never starve
 * the records queued behind it, which is the whole point of a per-record loop.
 */
export async function replaySettledUploadFollowups(
  queue: UploadQueue,
  session: MobileReplicaSession,
  gatewayBase: string
): Promise<FollowupReplaySummary> {
  let replayed = 0;
  let poisoned = 0;
  const waitingForVault: Record<string, number> = {};
  // A session holds exactly ONE vault (#996 wave 3). A follow-up addressed to
  // another one is not this session's to write.
  const sessionVaultId = session.scope?.()?.vaultId;
  const followups = queue.pendingFollowups();
  // Process the persisted follow-up queue in order: each canonical write may
  // alter the replica state observed by the next durable mutation.
  const replayNext = async (index: number): Promise<void> => {
    const followup = followups[index];
    if (!followup) return;
    if (
      followup.targetVaultId !== undefined &&
      sessionVaultId !== undefined &&
      followup.targetVaultId !== sessionVaultId
    ) {
      // P2 (#1014): this used to write through the MOUNTED session whatever
      // the row said, so a photograph queued for the family vault landed in
      // the personal one — in the wrong vault, and unrecoverably, because the
      // follow-up was cleared on the way. It waits instead.
      waitingForVault[followup.targetVaultId] =
        (waitingForVault[followup.targetVaultId] ?? 0) + 1;
      return replayNext(index + 1);
    }
    try {
      // F14d: the parent sha addresses the derivatives and the canonical write.
      // A malformed value would POST `variant_of=undefined` and write garbage,
      // so fail this one follow-up into the poison path instead.
      const parentSha = followup.input.staged_sha;
      if (typeof parentSha !== "string" || parentSha.length === 0) {
        throw new Error(
          "follow-up input.staged_sha is missing or not a string"
        );
      }
      if (followup.derivatives) {
        await contributeDeviceDerivatives(
          gatewayBase,
          parentSha,
          followup.derivatives
        );
      }
      const write = {
        action: followup.action,
        input: followup.input as ReplicaValue,
        intentId: followup.intentId,
      };
      // One open vault, and the row said it is this one (checked above).
      const outcome = await session.write(followup.shape, write);
      if (outcome.status === "denied" || outcome.status === "failed") {
        throw new Error(
          outcome.reason ??
            `canonical ${followup.shape}.${followup.action} write was ${outcome.status}`
        );
      }
      queue.clearFollowup(followup.followupId);
      if (followup.derivatives) cleanupDeviceDerivatives(followup.derivatives);
      replayed += 1;
    } catch (error) {
      const attempts = queue.countFollowupAttempt(followup.followupId);
      if (attempts >= MAX_FOLLOWUP_ATTEMPTS) {
        queue.poisonFollowup(followup.followupId, messageOf(error));
        if (followup.derivatives)
          cleanupDeviceDerivatives(followup.derivatives);
        poisoned += 1;
      }
    }
    return replayNext(index + 1);
  };
  await replayNext(0);
  return { replayed, poisoned, waitingForVault };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
