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
    case "failed":
      return "could not apply";
    case "executed":
      return "complete";
  }
}

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
  failed: "failed",
};

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

export function pendingChangeTitle(change: PendingChange): string {
  if (!change.appId || !change.action) return change.label;
  const words = presentWords(change.action);
  return words ? `${presentWords(change.appId)} · ${words}` : change.label;
}

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
  retry: boolean;
  discard: boolean;
  cancel: boolean;
  dismiss: boolean;
}

export function pendingChangeVerbs(change: PendingChange): PendingChangeVerbs {
  const overlay = pendingOverlayOf(change);
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

const STUCK_AFTER_MS = 60 * 60 * 1_000;

const UNSETTLED = new Set<PendingChangeStatus>([
  "queued",
  "sending",
  "in-flight",
  "awaiting-change",
]);

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

function presentWords(value: string): string {
  const tail = value.includes(".")
    ? value.slice(value.lastIndexOf(".") + 1)
    : value;
  const words = tail.replaceAll("_", " ").replaceAll("-", " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}
