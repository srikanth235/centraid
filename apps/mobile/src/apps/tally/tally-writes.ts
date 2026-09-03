import {
  COMPOSE_OUTCOMES,
  OFFLINE_MATERIALISE,
} from "@centraid/blueprints/apps/tally/compose-copy";
import type { TallyWrite } from "@centraid/blueprints/apps/tally/writes";

import { postStatus, showUndoStatus } from "../../kit/components/status-line";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import type { MobileReplicaSession } from "../../lib/replica/native-session";
import { refreshTally } from "./tally-store";

export interface TallyIssueOptions {
  executed: string;
  undo?: () => void;
  refresh?: boolean;
}

export async function issueTallyWrite(
  session: MobileReplicaSession | undefined,
  write: TallyWrite,
  options: TallyIssueOptions
): Promise<boolean> {
  if (!session) {
    surfaceWriteFailure(
      new Error("This phone is not paired with a gateway."),
      "Not recorded"
    );
    return false;
  }
  try {
    const outcome = await session.write("tally", {
      action: write.action,
      input: write.input as never,
    });
    const ok = surfaceWriteOutcome(outcome, {
      failureTitle: "Not recorded",
      queuedMessage: COMPOSE_OUTCOMES.added,
    });
    if (ok && outcome.status === "executed") {
      if (options.undo) showUndoStatus(options.executed, options.undo);
      else postStatus(options.executed);
    }
    if (ok && options.refresh !== false) await refreshTally();
    return ok;
  } catch (error) {
    surfaceWriteFailure(error, "Not recorded");
    return false;
  }
}

export async function materializeOccurrence(
  session: MobileReplicaSession | undefined,
  online: boolean,
  write: TallyWrite,
  executed: string
): Promise<boolean> {
  if (!online) {
    postStatus(OFFLINE_MATERIALISE);
    return false;
  }
  return issueTallyWrite(session, write, { executed });
}
