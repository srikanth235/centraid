import type { StopReason } from "@agentclientprotocol/sdk";

import type { TurnStreamEvent } from "@centraid/server/engine";

export interface StopReasonOutcome {
  emitFinal: boolean;
  notice?: Extract<TurnStreamEvent, { type: "notice" }>;
  error?: Extract<TurnStreamEvent, { type: "error" }>;
}

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
