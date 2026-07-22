/*
 * `session/prompt` RESULT `stopReason` — how the agent ended the turn.
 *
 * Wire values (ACP v1): end_turn | max_tokens | max_turn_requests | refusal |
 * cancelled. We used to ignore this and always emit `final`, so a refusal or
 * truncated turn looked like success to automations and the ledger. This
 * module is the single place that decides what to emit.
 */

import type { TurnStreamEvent } from '@centraid/app-engine';

/** Wire stopReason values we map explicitly (plus open-ended future values). */
type AcpStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled'
  | string;

export interface StopReasonOutcome {
  /** Emit `final` with accumulated assistant text? */
  emitFinal: boolean;
  /** Optional notice before final/error. */
  notice?: Extract<TurnStreamEvent, { type: 'notice' }>;
  /** Optional terminal error (e.g. refusal) — supersedes final when set. */
  error?: Extract<TurnStreamEvent, { type: 'error' }>;
}

/**
 * Map a wire `stopReason` to stream events. Caller still suppresses everything
 * when the local abort signal fired (that path emits `aborted` instead).
 */
export function outcomeForStopReason(stopReason: unknown): StopReasonOutcome {
  const reason: AcpStopReason = typeof stopReason === 'string' ? stopReason : 'end_turn';

  if (reason === 'end_turn') {
    return { emitFinal: true };
  }

  if (reason === 'cancelled') {
    return {
      emitFinal: true,
      notice: {
        type: 'notice',
        level: 'info',
        code: 'stop_cancelled',
        message: 'The agent stopped this turn (cancelled).',
      },
    };
  }

  if (reason === 'max_tokens' || reason === 'max_turn_requests') {
    return {
      emitFinal: true,
      notice: {
        type: 'notice',
        level: 'warn',
        code: 'stop_truncated',
        message:
          reason === 'max_tokens'
            ? 'The agent hit its output token limit before finishing — the reply may be incomplete.'
            : 'The agent hit its max turn/request limit before finishing — the reply may be incomplete.',
      },
    };
  }

  if (reason === 'refusal') {
    return {
      emitFinal: false,
      error: {
        type: 'error',
        message: 'The agent refused to complete this turn.',
      },
    };
  }

  // Unknown stop reasons: still deliver text, but say so.
  return {
    emitFinal: true,
    notice: {
      type: 'notice',
      level: 'info',
      code: 'stop_other',
      message: `The agent ended the turn with stopReason “${reason}”.`,
    },
  };
}
