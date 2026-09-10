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
  surfaceWriteRefusal,
} from "../../kit/replica/write-outcome";
import type { MobileReplicaSession } from "../../lib/replica/native-session";
import { refreshTally } from "./tally-store";

/** Tally's ONE error noun (#1015, S14): every failure and every refusal this
 *  seat surfaces says it, so a member never learns two names for one place. */
const TALLY_NOT_RECORDED = "Expense not recorded";

export interface TallyIssueOptions {
  /** What the status line says when the vault actually applied it. */
  executed: string;
  /** The one reverse write, where a true one exists. */
  undo?: () => void;
  /** Re-read the spine after a landed write. Off for acts whose surface is
   *  about to unmount anyway. */
  refresh?: boolean;
}

/**
 * The one door. Returns `true` when the act is safe to build on — executed, or
 * queued with its optimistic copy already on screen — and `false` when the
 * vault refused it or a steward has to answer first.
 */
export async function issueTallyWrite(
  session: MobileReplicaSession | undefined,
  write: TallyWrite,
  options: TallyIssueOptions
): Promise<boolean> {
  if (!session) {
    surfaceWriteRefusal("unpaired", TALLY_NOT_RECORDED);
    return false;
  }
  try {
    const outcome = await session.write("tally", {
      action: write.action,
      input: write.input as never,
    });
    const ok = surfaceWriteOutcome(outcome, {
      failureTitle: TALLY_NOT_RECORDED,
      // STATES.md, Tally / Add expense / offline: the commit says "queued on
      // this device". `COMPOSE_OUTCOMES.added` is that sentence, shared.
      queuedMessage: COMPOSE_OUTCOMES.added,
    });
    if (ok && outcome.status === "executed") {
      if (options.undo) showUndoStatus(options.executed, options.undo);
      else postStatus(options.executed);
    }
    if (ok && options.refresh !== false) await refreshTally();
    return ok;
  } catch (error) {
    surfaceWriteFailure(error, TALLY_NOT_RECORDED);
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
