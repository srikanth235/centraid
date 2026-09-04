/*
 * What a gateway outcome MEANS to the outbox (#922 G5).
 *
 * One place decides the state an outcome settles an intent into, and the
 * structured refusal that rides with it. It lives beside `intents.ts` rather
 * than inside it because the mapping is a policy, not a step of the drain: a
 * new outcome status is a row here, not another branch in the loop.
 */

import { conflictBaseIsMissing } from "./types.js";
import type {
  IntentOutcome,
  IntentState,
  ReplicaDenial,
  ReplicaIntent,
} from "./types.js";

/** The states whose optimistic projection is still on screen. */
export const OVERLAY_STATES = new Set<IntentState>([
  "queued",
  "sending",
  "awaiting-change",
  "parked",
  "denied",
  "conflict",
  "conflict-base-missing",
  "expired",
  "failed",
]);

/** Still shown and still the member's to act on, retry or not. */
export function retainedAttention(
  intent: ReplicaIntent | undefined
): intent is ReplicaIntent {
  return (
    intent?.state === "denied" ||
    intent?.state === "failed" ||
    intent?.state === "conflict" ||
    intent?.state === "conflict-base-missing" ||
    intent?.state === "expired" ||
    intent?.state === "parked"
  );
}

/** The member can retry it as it stands. */
export function actionableAttention(
  intent: ReplicaIntent | undefined
): intent is ReplicaIntent {
  return (
    intent?.state === "denied" ||
    intent?.state === "failed" ||
    intent?.state === "conflict" ||
    intent?.state === "conflict-base-missing"
  );
}

/**
 * The structured half of a refusal. #928 fills `code` and `subject` from the
 * consent plane's own verdict; until then the reason is the message and the
 * code says exactly that, so a seat rendering `denial` never has to fall back
 * to parsing prose.
 */
function denialOf(outcome: IntentOutcome): ReplicaDenial {
  return {
    code: outcome.denial?.code ?? "denied",
    message:
      outcome.denial?.message ?? outcome.reason ?? "This change was refused.",
    ...(outcome.denial?.subject ? { subject: outcome.denial.subject } : {}),
    ...(outcome.denial?.revokedAt
      ? { revokedAt: outcome.denial.revokedAt }
      : {}),
  };
}

export interface IntentVerdict {
  state: IntentState;
  denial?: ReplicaDenial;
}

/**
 * A conflict is its own state, and a conflict whose BASE ROW IS GONE is a
 * third one: the member's remedy differs, so the verdict must too.
 */
export function intentVerdict(outcome: IntentOutcome): IntentVerdict {
  if (outcome.status === "denied")
    return { state: "denied", denial: denialOf(outcome) };
  if (outcome.status !== "conflict") return { state: outcome.status };
  return {
    state:
      outcome.conflict && conflictBaseIsMissing(outcome.conflict)
        ? "conflict-base-missing"
        : "conflict",
  };
}
