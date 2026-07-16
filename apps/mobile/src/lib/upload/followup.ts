import type { ReplicaValue } from '@centraid/client/replica/native';

import type { NativeReplicaSession } from '../replica/native-session';
import { contributeDeviceDerivatives } from './derivatives-native';
import type { UploadQueue } from './native-queue';

/**
 * Finish every canonical mutation whose bytes have a durable casAck. A record
 * is removed only after `session.write` has either executed or entered the
 * replica intent outbox, so process death at any earlier point is recoverable.
 */
export async function replaySettledUploadFollowups(
  queue: UploadQueue,
  session: NativeReplicaSession,
  gatewayBase: string,
): Promise<number> {
  let replayed = 0;
  for (const followup of queue.pendingFollowups()) {
    if (followup.derivatives) {
      await contributeDeviceDerivatives(
        gatewayBase,
        followup.input.staged_sha as string,
        followup.derivatives,
      );
    }
    await session.write(followup.shape, {
      action: followup.action,
      input: followup.input as ReplicaValue,
      intentId: followup.intentId,
    });
    queue.clearFollowup(followup.followupId);
    replayed += 1;
  }
  return replayed;
}
