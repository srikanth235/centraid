/*
 * `session/prompt` RESULT `stopReason` — how the harness ended the turn.
 *
 * Wire values (ACP v1): end_turn | max_tokens | max_turn_requests | refusal |
 * cancelled. Ignoring it and always emitting `final` makes a refusal or a
 * truncated turn look like success to automations and the ledger. This
 * module is the single place that decides what to emit.
 */

import type { StopReason } from "@agentclientprotocol/sdk";

import type { TurnStreamEvent } from "@centraid/server/engine";

export interface StopReasonOutcome {
  /** Emit `final` with accumulated assistant text? */
  emitFinal: boolean;
  /** Optional notice before final/error. */
  notice?: Extract<TurnStreamEvent, { type: "notice" }>;
  /** Optional terminal error (e.g. refusal) — supersedes final when set. */
  error?: Extract<TurnStreamEvent, { type: "error" }>;
}

/**
 * Map a wire `stopReason` to stream events. Caller still suppresses everything
 * when the local abort signal fired (that path emits `aborted` instead).
 */
export function outcomeForStopReason(reason: StopReason): StopReasonOutcome {
  if (reason === "end_turn") {
    return { emitFinal: true };
  }

  if (reason === "cancelled") {
    return {
      emitFinal: true,
      notice: {
        type: "notice",
        level: "info",
        code: "stop_cancelled",
        message: "The harness stopped this turn (cancelled).",
      },
    };
  }

  if (reason === "max_tokens" || reason === "max_turn_requests") {
    return {
      emitFinal: true,
      notice: {
        type: "notice",
        level: "warn",
        code: "stop_truncated",
        message:
          reason === "max_tokens"
            ? "The harness hit its output token limit before finishing — the reply may be incomplete."
            : "The harness hit its max turn/request limit before finishing — the reply may be incomplete.",
      },
    };
  }

  if (reason === "refusal") {
    return {
      emitFinal: false,
      error: {
        type: "error",
        message: "The harness refused to complete this turn.",
      },
    };
  }

  reason satisfies never;
  throw new Error("unreachable ACP stop reason");
}
