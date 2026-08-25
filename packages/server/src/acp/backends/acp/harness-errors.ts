/*
 * Turn harness launch/session failures into owner-actionable messages.
 *
 * AUTH_REQUIRED (-32000) is the common case. Many agents instead fail
 * session/new with Internal error (-32603) or a stderr line about login —
 * goose is the documented example. This module keeps that taxonomy out of
 * the turn orchestrator.
 */

import { RequestError } from "@agentclientprotocol/sdk";

import type { HarnessFailureClass } from "@centraid/server/engine";

import { AUTH_REQUIRED_CODE } from "./connection.js";
import type { AcpTurnConfig } from "./types.js";

/**
 * The taxonomy is owned by `@centraid/server/engine` (the `TurnStreamEvent`
 * contract the breakers key off). Re-exported, never re-declared — two copies
 * of the union is how the classifier and the harness drift apart.
 */
export { type HarnessFailureClass } from "@centraid/server/engine";

/** ACP JSON-RPC "Internal error" — often a stand-in for "not configured". */
const INTERNAL_ERROR_CODE = -32603;

/**
 * JSON-RPC error codes that mean "provider said slow down / you are out of
 * budget". -32029 is the code harnesses in this space use for rate limits (the
 * scripted fixture mirrors it); 429 shows up when an adapter forwards the
 * HTTP status verbatim as the RPC code.
 */
const QUOTA_ERROR_CODES = new Set([-32029, 429, -429]);

/**
 * Errors this client itself authors when a bounded stage runs out of time.
 * These are structured signals — the stage name is in the string BECAUSE we
 * put it there — so they outrank any keyword scan of harness output.
 */
const OWN_WEDGE = /idle watchdog timed out/iu;
const OWN_STAGE_TIMEOUT = /^ACP (?<stage>.+?) timed out after \d+ms/iu;
const INIT_STAGES =
  /^(?<stage>initialize|session\/(?<sessionStage>new|load|resume))/iu;

const AUTHISH =
  /\b(?<authTerm>oauth|auth(?:entication|enticate(?:d|s)?|enticating)?|sign[\s-]?in|log[\s-]?in|not logged|unauthori[sz]ed|api[_ ]?key|credentials?|configure|provider)\b/iu;

const KEYWORD_CLASSES: Array<[RegExp, HarnessFailureClass]> = [
  [/\b(?<quota>rate limit|quota|too many requests|429)\b/iu, "quota"],
  [/\b(?<wedge>wedge|idle watchdog)\b/iu, "wedge"],
  [/\b(?<timeout>timeout|timed out)\b/iu, "timeout"],
  [/\b(?<spawn>spawn|enoent|binary)\b/iu, "spawn"],
  [/\b(?<exit>exit|exited|signal|broken pipe)\b/iu, "exit"],
];

function keywordClass(text: string): HarnessFailureClass | undefined {
  for (const [pattern, cls] of KEYWORD_CLASSES)
    if (pattern.test(text)) return cls;
  return undefined;
}

export interface ClassifiedHarnessFailure {
  failureClass: HarnessFailureClass;
  message: string;
}

export function authRequiredMessage(config: AcpTurnConfig): string {
  const label = config.label ?? config.kind;
  const hint = config.installHint ? ` ${config.installHint}` : "";
  return `${label} isn’t signed in, so it refused to start a session.${hint}`;
}

/**
 * Best-effort classification of a turn failure into a human message.
 * Prefer specific install/login hints over raw RPC strings.
 */
export function classifyHarnessFailure(
  err: unknown,
  stderr: string,
  config: AcpTurnConfig
): string {
  return classifyHarnessFailureDetail(err, stderr, config).message;
}

export function classifyHarnessFailureDetail(
  err: unknown,
  stderr: string,
  config: AcpTurnConfig
): ClassifiedHarnessFailure {
  const label = config.label ?? config.kind;
  const hint = config.installHint ? ` ${config.installHint}` : "";
  const combined = `${err instanceof Error ? err.message : String(err)}\n${stderr}`;

  if (err instanceof RequestError && err.code === AUTH_REQUIRED_CODE) {
    return { failureClass: "auth", message: authRequiredMessage(config) };
  }

  // A structured quota code beats the auth-ish heuristics below: rate-limit
  // stderr routinely mentions "provider" or "api key", which would otherwise
  // send a throttled harness down the "you are not signed in" path and tell the
  // owner to re-authenticate something that is working.
  if (err instanceof RequestError && QUOTA_ERROR_CODES.has(err.code)) {
    const tail = stderr.trim() ? `\n${stderr.trim().slice(-2000)}` : "";
    return { failureClass: "quota", message: `${err.message}${tail}` };
  }

  if (
    err instanceof RequestError &&
    err.code === INTERNAL_ERROR_CODE &&
    AUTHISH.test(combined)
  ) {
    return {
      failureClass: "auth",
      message:
        `${label} failed to start a session (often missing sign-in or provider setup).` +
        `${hint}` +
        (err.message ? ` (${err.message})` : ""),
    };
  }

  if (
    AUTHISH.test(combined) &&
    (err instanceof RequestError || /acp rpc/iu.test(combined))
  ) {
    return {
      failureClass: "auth",
      message:
        `${label} looks unauthenticated or unconfigured.` +
        `${hint}` +
        (stderr.trim() ? `\n${stderr.trim().slice(-1500)}` : ""),
    };
  }

  const msg = err instanceof Error ? err.message : String(err);
  const tail = stderr.trim() ? `\n${stderr.trim().slice(-2000)}` : "";
  return {
    failureClass: failureClassOf(err, msg, stderr),
    message: `${msg}${tail}`,
  };
}

/**
 * Classification precedence, strongest evidence first:
 *
 *   1. structured RPC error codes (the ACP peer told us in the protocol),
 *   2. errors this client authored (stage timeouts, the idle watchdog),
 *   3. keywords in the error MESSAGE,
 *   4. keywords in stderr.
 *
 * Order matters: a crashed harness whose stderr happens to mention "timeout"
 * must not be classified `timeout`, or the timeout breaker trips for a
 * crash. stderr is the weakest signal because it is unstructured vendor
 * output, so it is only consulted when nothing else decided.
 */
function failureClassOf(
  err: unknown,
  message: string,
  stderr: string
): HarnessFailureClass {
  if (err instanceof RequestError) {
    if (QUOTA_ERROR_CODES.has(err.code)) return "quota";
  }
  if (OWN_WEDGE.test(message)) return "wedge";
  const stage = OWN_STAGE_TIMEOUT.exec(message)?.groups?.stage;
  if (stage !== undefined) return INIT_STAGES.test(stage) ? "init" : "timeout";
  return (
    keywordClass(message) ??
    keywordClass(stderr) ??
    (err instanceof RequestError ? "init" : "unknown")
  );
}
