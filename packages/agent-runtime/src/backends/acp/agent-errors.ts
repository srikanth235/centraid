/*
 * Turn agent launch/session failures into owner-actionable messages.
 *
 * AUTH_REQUIRED (-32000) is the common case. Many agents instead fail
 * session/new with Internal error (-32603) or a stderr line about login —
 * goose is the documented example. This module keeps that taxonomy out of
 * the turn orchestrator.
 */

import type { AcpTurnConfig } from './types.js';
import { AUTH_REQUIRED_CODE, AcpRpcError } from './json-rpc.js';

/** ACP JSON-RPC "Internal error" — often a stand-in for "not configured". */
const INTERNAL_ERROR_CODE = -32603;

const AUTHISH =
  /\b(oauth|auth(?:entication|enticate(?:d|s)?|enticating)?|sign[\s-]?in|log[\s-]?in|not logged|unauthori[sz]ed|api[_ ]?key|credentials?|configure|provider)\b/i;

export type AgentFailureClass =
  | 'spawn'
  | 'auth'
  | 'init'
  | 'timeout'
  | 'quota'
  | 'wedge'
  | 'exit'
  | 'unknown';

export interface ClassifiedAgentFailure {
  failureClass: AgentFailureClass;
  message: string;
}

export function authRequiredMessage(config: AcpTurnConfig): string {
  const label = config.label ?? config.kind;
  const hint = config.installHint ? ` ${config.installHint}` : '';
  return `${label} isn’t signed in, so it refused to start a session.${hint}`;
}

/**
 * Best-effort classification of a turn failure into a human message.
 * Prefer specific install/login hints over raw RPC strings.
 */
export function classifyAgentFailure(err: unknown, stderr: string, config: AcpTurnConfig): string {
  return classifyAgentFailureDetail(err, stderr, config).message;
}

export function classifyAgentFailureDetail(
  err: unknown,
  stderr: string,
  config: AcpTurnConfig,
): ClassifiedAgentFailure {
  const label = config.label ?? config.kind;
  const hint = config.installHint ? ` ${config.installHint}` : '';
  const combined = `${err instanceof Error ? err.message : String(err)}\n${stderr}`;

  if (err instanceof AcpRpcError && err.code === AUTH_REQUIRED_CODE) {
    return { failureClass: 'auth', message: authRequiredMessage(config) };
  }

  if (err instanceof AcpRpcError && err.code === INTERNAL_ERROR_CODE && AUTHISH.test(combined)) {
    return {
      failureClass: 'auth',
      message:
        `${label} failed to start a session (often missing sign-in or provider setup).` +
        `${hint}` +
        (err.message ? ` (${err.message})` : ''),
    };
  }

  if (AUTHISH.test(combined) && (err instanceof AcpRpcError || /acp rpc/i.test(combined))) {
    return {
      failureClass: 'auth',
      message:
        `${label} looks unauthenticated or unconfigured.` +
        `${hint}` +
        (stderr.trim() ? `\n${stderr.trim().slice(-1500)}` : ''),
    };
  }

  const msg = err instanceof Error ? err.message : String(err);
  const tail = stderr.trim() ? `\n${stderr.trim().slice(-2000)}` : '';
  const lower = combined.toLowerCase();
  const failureClass: AgentFailureClass = /\b(rate limit|quota|too many requests|429)\b/.test(lower)
    ? 'quota'
    : /\b(wedge|idle watchdog)\b/.test(lower)
      ? 'wedge'
      : /\b(timeout|timed out)\b/.test(lower)
        ? 'timeout'
        : /\b(spawn|enoent|binary)\b/.test(lower)
          ? 'spawn'
          : /\b(exit|exited|signal|broken pipe)\b/.test(lower)
            ? 'exit'
            : err instanceof AcpRpcError
              ? 'init'
              : 'unknown';
  return { failureClass, message: `${msg}${tail}` };
}
