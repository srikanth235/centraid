import type { ReplicaValue } from "@centraid/client/replica/native";

import type { MobileReplicaSession } from "../replica/native-session";
import {
  cleanupDeviceDerivatives,
  contributeDeviceDerivatives,
} from "./derivatives-native";
import type { UploadQueue } from "./native-queue";

const MAX_FOLLOWUP_ATTEMPTS = 5;

export interface FollowupReplaySummary {
  replayed: number;
  poisoned: number;
}

export async function replaySettledUploadFollowups(
  queue: UploadQueue,
  session: MobileReplicaSession,
  gatewayBase: string
): Promise<FollowupReplaySummary> {
  let replayed = 0;
  let poisoned = 0;
  const followups = queue.pendingFollowups();
  const replayNext = async (index: number): Promise<void> => {
    const followup = followups[index];
    if (!followup) return;
    try {
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
      const outcome =
        followup.targetVaultId && session.writeTo
          ? await session.writeTo(followup.targetVaultId, followup.shape, write)
          : await session.write(followup.shape, write);
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
  return { replayed, poisoned };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
