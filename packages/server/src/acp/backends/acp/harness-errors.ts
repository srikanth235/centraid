import { RequestError } from "@agentclientprotocol/sdk";

import type { HarnessFailureClass } from "@centraid/server/engine";

import { AUTH_REQUIRED_CODE } from "./connection.js";
import type { AcpTurnConfig } from "./types.js";

export { type HarnessFailureClass } from "@centraid/server/engine";

const INTERNAL_ERROR_CODE = -32603;

const QUOTA_ERROR_CODES = new Set([-32029, 429, -429]);

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
