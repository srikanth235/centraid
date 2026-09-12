// WHAT AN INTENT'S STATE MEANS TO THE MEMBER WHO MADE IT (#922 G5).
//
// The queue's states are the QUEUE's vocabulary — queued, sending,
// awaiting-change, parked, executed, denied, conflict, failed — and a `write()`
// answers in the member's: saved, sending, waiting, refused. This is the one
// translation between them, and it is a module rather than a method because
// BOTH seats make it and they must not drift: a conflict shown on the phone and
// swallowed in the browser is the same bug twice.
//
// `awaiting-change` IS IN-FLIGHT, not settled. The gateway committed and this
// seat has not applied the commit yet (#996, R24); the write succeeded and the
// row is still the overlay's. Reporting it as executed would clear the badge
// before the rows it is drawn over arrive.

import { GatewayClientError } from "../gateway-auth.js";
import { ReplicaTransportError } from "./shell-transport.js";
import type { IntentOutcome, ReplicaIntent } from "./types.js";

/**
 * The refusal every drain treats as terminal-for-now: the credential is gone,
 * so no retry of this intent can work until the session is re-authorized.
 * ONE definition, because both seats build a drain host out of it and a
 * duplicate is how the phone and the browser drift (#1014).
 */
export function isAuthorizationError(error: unknown): boolean {
  return error instanceof GatewayClientError && error.code === "auth_required";
}

export type ReplicaWriteResult =
  | IntentOutcome
  | { intentId: string; status: "queued" | "in-flight"; reason?: string };

/** The answer an intent ALREADY carries, if it has one. */
export function admissionResult(
  intent: ReplicaIntent
): ReplicaWriteResult | undefined {
  if (intent.state === "awaiting-change")
    return { intentId: intent.intentId, status: "in-flight" };
  if (
    intent.state !== "parked" &&
    intent.state !== "executed" &&
    intent.state !== "denied" &&
    intent.state !== "failed"
  ) {
    return undefined;
  }
  return {
    intentId: intent.intentId,
    status: intent.conflict ? "conflict" : intent.state,
    ...(intent.reason ? { reason: intent.reason } : {}),
    ...(intent.output === undefined ? {} : { output: intent.output }),
    ...(intent.conflict === undefined ? {} : { conflict: intent.conflict }),
  };
}

/**
 * A refusal the gateway will give again for the same intent.
 *
 * 4xx except 408 and 429: those two are the gateway saying "not now", which is
 * a retry, and retrying anything else is a queue that never drains behind a
 * write that can never succeed.
 */
export function isPermanentIntentRejection(
  error: unknown
): error is ReplicaTransportError {
  return (
    error instanceof ReplicaTransportError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The two sentences a queued write is described by; said once, so they match. */
export const QUEUED_OFFLINE = "saved locally; waiting for a connection";
export const QUEUED_RETRYING =
  "saved locally; retrying when the gateway is reachable";
