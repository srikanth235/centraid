import { authHeaders, GatewayClientError, href } from "../gateway-auth.js";
import type { GatewayAuth } from "../gateway-auth.js";
import {
  ReplicaProtocolError,
  ReplicaRebootstrapRequiredError,
} from "./errors.js";
import { chainRecoveryFromExpiredOutcome } from "./offline-chain.js";
import { ReplicaIntentRecoveryError } from "./replica-intent-recovery-error.js";
import type { RebootstrapReason } from "./replica-rebootstrap-error.js";
import type { IntentOutcome, ReplicaIntent } from "./types.js";
import { bumpClientWorkCounter } from "./work-counters.js";

/** Request init widened with `cache`, which React Native's `RequestInit` type omits. */
export type ReplicaRequestInit = RequestInit & { cache?: string };

export type ReplicaFetcher = (
  baseUrl: string,
  pathname: string,
  init: ReplicaRequestInit
) => Promise<Response>;

/**
 * Fallback transport for platforms/tests that don't inject one. The web shell
 * always passes its own `doFetch` wrapper (Iroh/webControl/vault-header aware);
 * this plain `fetch` keeps the module free of the browser gateway core so React
 * Native can reuse it with an injected fetcher.
 */
const defaultReplicaFetcher: ReplicaFetcher = (baseUrl, pathname, init) =>
  fetch(href(baseUrl, pathname), init as RequestInit);

/**
 * #927 P2: one `httpRoundTrips` bump per call into the transport, wrapped at
 * the ONE seam every replica request already goes through. Counting here rather
 * than at six call sites means a new request path is counted the day it is
 * written, and an injected fetcher (the web shell's Iroh/webControl wrapper,
 * the native one) is counted exactly like the default.
 */
function countedRoundTrip(fetcher: ReplicaFetcher): ReplicaFetcher {
  return (baseUrl, pathname, init) => {
    bumpClientWorkCounter("httpRoundTrips");
    return fetcher(baseUrl, pathname, init);
  };
}

export class ReplicaTransportError extends GatewayClientError {
  constructor(
    code: string,
    message: string,
    readonly status: number,
    readonly category:
      | "auth"
      | "validation"
      | "conflict"
      | "rebootstrap"
      | "transient"
      | "server" = "server",
    readonly retryable = false,
    readonly recommendedAction:
      | "reauthenticate"
      | "rebootstrap"
      | "retry"
      | "fix-request"
      | "resolve-conflict"
      | "none" = "none",
    readonly details?: unknown
  ) {
    super(code, message);
    this.name = "ReplicaTransportError";
  }
}

export interface ReplicaIntentResponse {
  outcome:
    | IntentOutcome
    | { intentId: string; status: "in-flight"; reason?: string };
}

export async function postReplicaIntent(
  gatewayAuth: GatewayAuth,
  intent: ReplicaIntent,
  fetcher: ReplicaFetcher = defaultReplicaFetcher
): Promise<ReplicaIntentResponse> {
  const response = await countedRoundTrip(fetcher)(
    gatewayAuth.baseUrl,
    "/centraid/_vault/replica/intents",
    {
      method: "POST",
      headers: {
        ...authHeaders(gatewayAuth.token, "application/json"),
        Accept: "application/json",
      },
      body: JSON.stringify({
        intentId: intent.intentId,
        appId: intent.appId,
        action: intent.action,
        input: intent.input,
        payloadHash: intent.payloadHash,
        ...(intent.baseVersions ? { baseVersions: intent.baseVersions } : {}),
        // THE CHAIN GOES ON THE WIRE (#996, R23). It is part of the payload
        // hash the gateway verifies the id against, so an intent that derived
        // edges and did not send them is refused — correctly.
        ...(intent.dependsOn && intent.dependsOn.length > 0
          ? { dependsOn: intent.dependsOn }
          : {}),
      }),
    }
  );
  const raw = await readReplicaJson<unknown>(response, "ship replica intent");
  if (!raw || typeof raw !== "object" || !("outcome" in raw)) {
    throw new ReplicaProtocolError(
      "Intent response did not contain an outcome"
    );
  }
  const outcome = parseOutcome((raw as { outcome: unknown }).outcome, true);
  if (outcome.intentId !== intent.intentId) {
    throw new ReplicaProtocolError(
      "Intent response did not match the submitted intent"
    );
  }
  return { outcome };
}

async function readReplicaJson<T>(
  response: Response,
  operation: string
): Promise<T> {
  let body: unknown;
  let parsed = false;
  try {
    body = await response.json();
    parsed = true;
  } catch {
    if (response.ok)
      throw new ReplicaProtocolError(`${operation} returned malformed JSON`);
  }
  if (
    parsed &&
    body !== null &&
    typeof body === "object" &&
    (response.status === 409 || response.status === 410)
  ) {
    // NOT EVERY 409 IS ABOUT THE COPY. Two are about one queued write, and
    // answering them with a re-bootstrap would replace a whole vault to
    // resolve a question about one task.
    const recovery = intentRecoveryFrom(body);
    if (recovery) throw recovery;
    throw new ReplicaRebootstrapRequiredError(rebootstrapReason(body));
  }
  const serverCode =
    body &&
    typeof body === "object" &&
    typeof (body as { error?: unknown }).error === "string"
      ? String((body as { error: string }).error)
      : undefined;
  const envelope =
    body && typeof body === "object"
      ? (body as {
          message?: unknown;
          category?: unknown;
          retryable?: unknown;
          recommendedAction?: unknown;
          details?: unknown;
        })
      : {};
  if (
    parsed &&
    (response.status === 401 ||
      (response.status === 403 && serverCode === "replica_device_not_enrolled"))
  ) {
    throw new GatewayClientError(
      "auth_required",
      `${operation}: device authorization was revoked`
    );
  }
  if (!response.ok) {
    const category = isReplicaErrorCategory(envelope.category)
      ? envelope.category
      : response.status === 409
        ? "conflict"
        : response.status >= 500
          ? "server"
          : "validation";
    const retryable =
      typeof envelope.retryable === "boolean"
        ? envelope.retryable
        : response.status === 408 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500;
    const recommendedAction = isReplicaErrorAction(envelope.recommendedAction)
      ? envelope.recommendedAction
      : retryable
        ? "retry"
        : category === "validation"
          ? "fix-request"
          : category === "conflict"
            ? "resolve-conflict"
            : "none";
    throw new ReplicaTransportError(
      serverCode ??
        (response.status >= 500 ? "gateway_error" : "replica_request_rejected"),
      typeof envelope.message === "string"
        ? `${operation}: ${envelope.message}`
        : `${operation} failed (HTTP ${response.status})`,
      response.status,
      category,
      retryable,
      recommendedAction,
      envelope.details
    );
  }
  return body as T;
}

function isReplicaErrorCategory(
  value: unknown
): value is ReplicaTransportError["category"] {
  return (
    value === "auth" ||
    value === "validation" ||
    value === "conflict" ||
    value === "rebootstrap" ||
    value === "transient" ||
    value === "server"
  );
}

function isReplicaErrorAction(
  value: unknown
): value is ReplicaTransportError["recommendedAction"] {
  return (
    value === "reauthenticate" ||
    value === "rebootstrap" ||
    value === "retry" ||
    value === "fix-request" ||
    value === "resolve-conflict" ||
    value === "none"
  );
}

function rebootstrapReason(body: unknown): RebootstrapReason {
  const reason =
    body && typeof body === "object"
      ? (body as { reason?: unknown }).reason
      : undefined;
  if (reason === "protocol-mismatch" || reason === "vault-mismatch")
    return reason;
  if (reason === "schema-mismatch" || reason === "schema-changed")
    return "schema-mismatch";
  if (reason === "epoch-mismatch" || reason === "restore")
    return "epoch-mismatch";
  return "cursor-gap";
}

const INTENT_RECOVERY_ERRORS = new Set([
  "replica_intent_outcome_expired",
  "replica_intent_payload_mismatch",
]);

function intentRecoveryFrom(
  body: object
): ReplicaIntentRecoveryError | undefined {
  const shaped = body as {
    error?: unknown;
    intentId?: unknown;
    reason?: unknown;
    recovery?: unknown;
  };
  if (
    typeof shaped.error !== "string" ||
    !INTENT_RECOVERY_ERRORS.has(shaped.error)
  )
    return undefined;
  return new ReplicaIntentRecoveryError(
    typeof shaped.intentId === "string" ? shaped.intentId : "unknown",
    shaped.error,
    chainRecoveryFromExpiredOutcome({
      error: "replica_intent_outcome_expired",
      recovery: "resubmit-as-new-intent",
      ...(typeof shaped.reason === "string" ? { reason: shaped.reason } : {}),
    })
  );
}

function parseOutcome(
  value: unknown,
  allowInFlight: boolean
): IntentOutcome | { intentId: string; status: "in-flight"; reason?: string } {
  if (!value || typeof value !== "object") {
    throw new ReplicaProtocolError("Replica intent outcome is malformed");
  }
  const candidate = value as Record<string, unknown>;
  const allowed = allowInFlight
    ? new Set([
        "executed",
        "parked",
        "denied",
        "failed",
        "conflict",
        "in-flight",
      ])
    : new Set(["executed", "parked", "denied", "failed", "conflict"]);
  if (
    typeof candidate.intentId !== "string" ||
    !allowed.has(String(candidate.status))
  ) {
    throw new ReplicaProtocolError(
      "Replica intent outcome has an unknown status"
    );
  }
  if (
    candidate.commitSeq !== undefined &&
    (!Number.isSafeInteger(candidate.commitSeq) ||
      Number(candidate.commitSeq) < 1)
  ) {
    // R24: the position the overlay waits on. A malformed one would either
    // clear a badge that should still be showing or hold one forever.
    throw new ReplicaProtocolError(
      "Replica intent outcome commit position is malformed"
    );
  }
  if (candidate.reason !== undefined && typeof candidate.reason !== "string") {
    throw new ReplicaProtocolError(
      "Replica intent outcome reason is malformed"
    );
  }
  if (candidate.conflict !== undefined) {
    const conflict = candidate.conflict;
    if (!conflict || typeof conflict !== "object")
      throw new ReplicaProtocolError("Replica conflict details are malformed");
    const detail = conflict as Record<string, unknown>;
    if (
      typeof detail.entity !== "string" ||
      typeof detail.rowId !== "string" ||
      !Number.isSafeInteger(detail.expectedVersion) ||
      !Number.isSafeInteger(detail.actualVersion)
    ) {
      throw new ReplicaProtocolError("Replica conflict details are malformed");
    }
  }
  return value as
    | IntentOutcome
    | { intentId: string; status: "in-flight"; reason?: string };
}
