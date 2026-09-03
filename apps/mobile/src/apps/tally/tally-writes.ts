// EVERY WRITE TALLY ISSUES FROM THIS SEAT, and the door each one takes.
//
// ONE DOOR FOR EVERYTHING BUT ONE ACT. Tally is record-only and fully
// offline-capable: every act has an optimistic pending projection
// (`apps/tally/pending-projection.ts`), so every act goes through
// `session.write` and queues in the durable outbox when the gateway is out of
// reach. The commit says so — "queued on this device" — rather than leaving a
// member to discover it.
//
// THE ONE EXCEPTION IS MATERIALISING A RECURRING OCCURRENCE. Its id is minted
// by the canonical recurrence engine, so the projection EXCLUDES it by
// construction, and a queued copy would claim an expense with an id nobody
// issued. `materializeOccurrence` therefore refuses while offline and says
// why; Due next repeats the fact where the member is standing (§6, "Due
// occurrence").
//
// The payloads are NOT built here. `apps/tally/writes.ts` is the shared write
// door — one builder per manifested action, each carrying exactly the input
// that action's schema requires — so a field the vault would reject cannot
// arrive from a render on any seat. This module hands those values to the
// native session and turns the outcome into a sentence.
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

/**
 * THE ONE WRITE WITH NO OPTIMISTIC COPY.
 *
 * Withheld rather than offered-and-refused: a control that fires into a queue
 * whose outcome can never be projected would claim an expense the engine has
 * not minted. Offline, the caller draws the sentence instead of the verb —
 * this guard is the second line, for the case where the connection dies
 * between the render and the press.
 */
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
