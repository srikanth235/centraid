import type { ReplicaValue } from '@centraid/client/replica/native';

import type { NativeReplicaSession } from '../replica/native-session';
import { cleanupDeviceDerivatives, contributeDeviceDerivatives } from './derivatives-native';
import type { UploadQueue } from './native-queue';

/** After this many failed replays a follow-up is quarantined, not retried (F4). */
const MAX_FOLLOWUP_ATTEMPTS = 5;

export interface FollowupReplaySummary {
  /** Records whose canonical mutation executed (or entered the outbox). */
  replayed: number;
  /** Records quarantined this pass after exhausting their attempts. */
  poisoned: number;
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
  session: NativeReplicaSession,
  gatewayBase: string,
): Promise<FollowupReplaySummary> {
  let replayed = 0;
  let poisoned = 0;
  for (const followup of queue.pendingFollowups()) {
    try {
      // F14d: the parent sha addresses the derivatives and the canonical write.
      // A malformed value would POST `variant_of=undefined` and write garbage,
      // so fail this one follow-up into the poison path instead.
      const parentSha = followup.input.staged_sha;
      if (typeof parentSha !== 'string' || parentSha.length === 0) {
        throw new Error('follow-up input.staged_sha is missing or not a string');
      }
      if (followup.derivatives) {
        await contributeDeviceDerivatives(gatewayBase, parentSha, followup.derivatives);
      }
      await session.write(followup.shape, {
        action: followup.action,
        input: followup.input as ReplicaValue,
        intentId: followup.intentId,
      });
      queue.clearFollowup(followup.followupId);
      if (followup.derivatives) cleanupDeviceDerivatives(followup.derivatives);
      replayed += 1;
    } catch (error) {
      const attempts = queue.countFollowupAttempt(followup.followupId);
      if (attempts >= MAX_FOLLOWUP_ATTEMPTS) {
        queue.poisonFollowup(followup.followupId, messageOf(error));
        if (followup.derivatives) cleanupDeviceDerivatives(followup.derivatives);
        poisoned += 1;
      }
    }
  }
  return { replayed, poisoned };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
