// The pending sheet's WORDS and its verbs, in a pure module.
//
// The law behind them is one file for both seats
// (`packages/blueprints/apps/_shared/pending-overlay.ts`): what a stopped
// write says, which versions a conflict prints, and which of Retry/Discard it
// may offer. This module adapts one outbox row to that law and adds nothing to
// it, so the phone and the browser cannot drift into two vocabularies for the
// same stopped write.

import {
  pendingOverlayCanDiscard,
  pendingOverlayCanRetry,
  pendingOverlayCopy,
} from "@centraid/blueprints/apps/_shared/pending-overlay";
import type {
  PendingOverlayPresentation,
  PendingOverlayStatus,
} from "@centraid/blueprints/apps/_shared/pending-overlay";
import { formatRelativeTime } from "@centraid/design";

import type { PendingChangeStatus } from "../../lib/replica/multi-vault-session";
import type { PendingChange } from "./pending-changes";

/**
 * Every outbox state in a member's words. Exhaustive over the union with no
 * `default` arm: the old fallthrough printed the engine's own word — a member
 * reading "conflict" in a sheet is reading a database term, not a sentence.
 */
export function humanStatus(status: PendingChangeStatus): string {
  switch (status) {
    case "queued":
      return "waiting to send";
    case "sending":
    case "in-flight":
    case "awaiting-change":
      return "being applied";
    case "parked":
      return "needs attention";
    case "denied":
      return "permission changed";
    case "conflict":
      return "changed somewhere else";
    case "conflict-base-missing":
      return "the original is gone";
    case "expired":
      return "waited too long";
    case "failed":
      return "could not apply";
    case "executed":
      return "complete";
  }
}

/** How each outbox state reads to the shared overlay law. */
const OVERLAY_STATUS: Readonly<
  Partial<Record<PendingChangeStatus, PendingOverlayStatus>>
> = {
  queued: "queued",
  sending: "sending",
  "in-flight": "sending",
  "awaiting-change": "sending",
  parked: "parked",
  denied: "denied",
  conflict: "conflict",
  "conflict-base-missing": "conflict-base-missing",
  expired: "expired",
  failed: "failed",
};

/** One outbox row as the shared law sees it; `executed` has settled and is gone. */
export function pendingOverlayOf(
  change: PendingChange
): PendingOverlayPresentation | undefined {
  const status = OVERLAY_STATUS[change.status];
  if (!status) return undefined;
  return {
    key: change.id,
    status,
    action: change.action ?? change.label,
    ...(change.reason ? { reason: change.reason } : {}),
    ...(change.expectedVersion === undefined
      ? {}
      : { expectedVersion: change.expectedVersion }),
    ...(change.actualVersion === undefined
      ? {}
      : { actualVersion: change.actualVersion }),
    ...(change.attempts === undefined ? {} : { attempts: change.attempts }),
    ...(change.enqueuedAt ? { enqueuedAt: change.enqueuedAt } : {}),
  };
}

/**
 * The row's title, as an act rather than as an intent record. `tally:
 * add_expense` is the vault's vocabulary and the seats parse it; a member
 * reads what they did and where it is going.
 */
export function pendingChangeTitle(change: PendingChange): string {
  if (!change.appId || !change.action) return change.label;
  const words = presentWords(change.action);
  return words ? `${presentWords(change.appId)} · ${words}` : change.label;
}

/**
 * The sentence under the row, for the states where the law says more than the
 * status word does: parked names the steward, conflict prints both versions,
 * denied and failed carry the reason the vault gave.
 */
export function pendingChangeExplanation(
  change: PendingChange
): string | undefined {
  const overlay = pendingOverlayOf(change);
  if (
    overlay &&
    (overlay.status === "parked" || pendingOverlayCanRetry(overlay))
  )
    return pendingOverlayCopy(overlay);
  return change.reason;
}

/** Which doors this row actually has; drawing one that cannot fire is worse
 *  than drawing none (protocol C1). */
export interface PendingChangeVerbs {
  /** Re-admit the same write. An intent-outbox verb only. */
  retry: boolean;
  /** Drop the retained row and the projection standing on it. */
  discard: boolean;
  /** Retire a write that has not settled yet. */
  cancel: boolean;
  /** Clear a settled row that offers nothing else. */
  dismiss: boolean;
}

export function pendingChangeVerbs(change: PendingChange): PendingChangeVerbs {
  const overlay = pendingOverlayOf(change);
  // Retry and Discard are the intent outbox's own verbs. A placement's outbox
  // has neither (multi-vault-reader.ts), so those rows keep Cancel and Dismiss
  // — and neither does an attention remnant, the last trace of a write the
  // outbox no longer holds. `attempts` is the tell: only a retained intent
  // carries one (native-session.ts `pendingChanges`).
  const outbox =
    change.kind === "replica" &&
    overlay !== undefined &&
    change.attempts !== undefined;
  const retry = outbox && pendingOverlayCanRetry(overlay);
  const discard = outbox && pendingOverlayCanDiscard(overlay);
  const settled =
    change.status === "executed" ||
    change.status === "denied" ||
    change.status === "conflict" ||
    change.status === "failed";
  return {
    retry,
    discard,
    cancel: !settled,
    dismiss: settled && !discard,
  };
}

/**
 * How long a row has to wait before "slow" becomes "stuck".
 *
 * Every ordinary way back is shorter than this: a foreground, a network
 * change, and the OS scheduler's own 15-minute background pass
 * (lib/replica/background-sync.ts). An hour is four of those wakes, so a row
 * still waiting past it is genuinely stuck — and saying so any earlier would
 * call a lunch out of coverage a fault.
 */
const STUCK_AFTER_MS = 60 * 60 * 1_000;

const UNSETTLED = new Set<PendingChangeStatus>([
  "queued",
  "sending",
  "in-flight",
  "awaiting-change",
]);

/** One quiet line, and only for a row nothing has moved in an hour. */
export function pendingChangeStuckLine(
  change: PendingChange,
  now: number = Date.now()
): string | undefined {
  if (!change.enqueuedAt || !UNSETTLED.has(change.status)) return undefined;
  const enqueuedAt = Date.parse(change.enqueuedAt);
  if (!Number.isFinite(enqueuedAt) || now - enqueuedAt < STUCK_AFTER_MS)
    return undefined;
  const attempts = change.attempts ?? 0;
  const waited = `Queued ${formatRelativeTime(enqueuedAt, now)}`;
  return attempts > 0
    ? `${waited} · ${attempts} attempt${attempts === 1 ? "" : "s"}`
    : waited;
}

/** `add_expense` and `tally` alike, as a fragment a member can read. */
function presentWords(value: string): string {
  const tail = value.includes(".")
    ? value.slice(value.lastIndexOf(".") + 1)
    : value;
  const words = tail.replaceAll("_", " ").replaceAll("-", " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}
