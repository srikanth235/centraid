import { pendingOverlayCopy } from "@centraid/blueprints/apps/_shared/pending-overlay";

import type { NativeWriteResult } from "../../lib/replica/native-session";
import { postStatus, readStatus } from "../components/status-line";
import { TRY_AGAIN } from "../rooms/read-failure";

/** Where a conflicted write waits, and what can be done to it there. */
const CONFLICT_ROUTE = "Open Pending changes to retry or discard.";

export interface SurfaceWriteOutcomeOptions {
  failureTitle?: string;
  /** Replaces the default parked Alert (e.g. navigate to Approvals). */
  onParked?: () => void;
  /** Replaces the default conflict status line (e.g. reopen the editor). */
  onConflict?: () => void;
  queuedMessage?: string;
  /** Replaces the default queued Alert (e.g. an in-line pending banner). */
  onQueued?: () => void;
  /** Replaces the default in-flight Alert. */
  onInFlight?: () => void;
}

/**
 * Turns every native intent admission outcome into an immediate user-visible
 * result. Executed writes are already visible through their optimistic
 * mutation; every other state needs an explicit affordance.
 *
 * News uses the app-wide status line; decisions remain with the caller's
 * dialog. Returns whether the caller may continue an optimistic success flow
 * (for example, close a modal, extract `output`, or navigate away).
 */
export function surfaceWriteOutcome(
  result: NativeWriteResult,
  options: SurfaceWriteOutcomeOptions = {}
): boolean {
  if (result.status === "executed") return true;
  if (result.status === "parked") {
    if (options.onParked) options.onParked();
    else
      postStatus(result.reason ?? "This change is ready for owner approval.");
    return false;
  }
  if (result.status === "queued") {
    if (options.onQueued) options.onQueued();
    // AN ACTIONABLE NOTE OUTRANKS NEWS (#1015, S3 — audit B3). There is one
    // line, updated in place, with at most one inline action (DESIGN.md
    // invariant 5), so "queue behind it" would need a second slot and "post it
    // anyway" is what destroyed Tasks' own Undo: check-off posted
    // `DONE + Undo`, the queued outcome of the very write that caused it
    // landed a beat later, and the only door back was gone.
    //
    // The queued fact is therefore SUPPRESSED while an action is live, not
    // deferred: it is not lost, because the same change is listed in Pending
    // changes with its own reason, whereas an undo that has already been
    // painted over cannot be recovered by anything the member can reach.
    else if (!readStatus()?.action)
      postStatus(
        options.queuedMessage ??
          "Saved offline — it will sync when the gateway reconnects."
      );
    return true;
  }
  if (result.status === "conflict") {
    // A conflict is NOT a failure to report and forget: the change is retained
    // with both versions until the member edits, retries or discards it
    // (docs/mobile-offline.md), so this says which row moved under the write
    // and where the row that can undo it lives. Collapsing it into "Change not
    // applied" told a member their work was gone when it was still on the phone.
    if (options.onConflict) options.onConflict();
    else
      postStatus(
        `${pendingOverlayCopy({
          key: result.intentId,
          status: "conflict",
          action: "",
          // NO VERSION NUMBERS ON THE PHONE (#1015, S14 — R-A-15). The
          // sidecar carries them and Pending changes may show them; a status
          // line that says "Expected version 7; found 8" tells a member a
          // number they cannot act on in the one slot that has to say what
          // happened and where the door is.
          ...(result.reason ? { reason: result.reason } : {}),
        })} ${CONFLICT_ROUTE}`
      );
    return false;
  }
  if (result.status === "in-flight") {
    if (options.onInFlight) options.onInFlight();
    // Same rank as queued above: this is news about the write the member just
    // made, and it must not paint over the door back from it. A refusal or a
    // failure still posts — those are not news, they are the answer.
    else if (!readStatus()?.action)
      postStatus("Saving — the final status remains visible in sync status.");
    return true;
  }
  // A REFUSAL IS NOT AN EXCEPTION AND NOT A SENTENCE THE VAULT WRITES
  // (#1015, S14 — R-A-18). `result.reason` is the engine's own words, with a
  // receipt id and scope in them as often as not; it goes to the log, and the
  // member gets the surface's noun and the one thing that is true.
  surfaceWriteRefusal(
    "denied",
    options.failureTitle ?? "Change not applied",
    result.reason
  );
  return false;
}

/**
 * WHY A WRITE DID NOT LAND WHEN NOTHING THREW (#1015, S14 — R-A-15).
 *
 * Before this channel existed, a caller that wanted a refusal on screen
 * wrapped it in `new Error(reason)` and handed it to `surfaceWriteFailure`
 * (`locker-writes.ts` did it three times), which is how engine words got a
 * ride into member copy. A refusal has its own shape: the surface's noun, one
 * of two true routes, and the raw in the log where a debug session starts
 * (docs/logs.md).
 */
export type WriteRefusal = "unpaired" | "denied";

const REFUSAL_ROUTE: Record<WriteRefusal, string> = {
  denied: "The vault did not allow this change.",
  unpaired: "Pair or reconnect a vault host.",
};

export function surfaceWriteRefusal(
  kind: WriteRefusal,
  failureTitle: string,
  detail?: string
): void {
  if (detail !== undefined && detail !== "")
    console.warn("[write] refused", failureTitle, detail);
  postStatus(`${failureTitle}. ${REFUSAL_ROUTE[kind]}`);
}

/**
 * THE ONE WRITE FAILURE (#1015, S14 — R-A-15), the twin of `readFailure`.
 *
 * The exception is NOT the message. `error.message` on this seat is whatever
 * the transport, the SQLite driver or the intent admitter threw — a status
 * code, a constraint name, an empty string — and forty call sites were
 * pasting it into the one status line. What the member gets is the surface's
 * own noun and the product's one retry word; the raw goes to the log, which
 * is where a debug session starts (docs/logs.md).
 */
export function surfaceWriteFailure(
  error: unknown,
  failureTitle = "Change not saved"
): void {
  console.warn("[write] failed", failureTitle, error);
  postStatus(`${failureTitle}. ${TRY_AGAIN}.`);
}

/** Extract the executed/queued command output bag when present. */
export function nativeWriteOutput(
  result: NativeWriteResult | undefined
): Record<string, unknown> | undefined {
  if (!result || !("output" in result) || !result.output) return undefined;
  return result.output as Record<string, unknown>;
}
