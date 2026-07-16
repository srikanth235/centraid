// Assistant transcript model + codecs (issue #420). The mutable message model
// AssistantRoute keeps in a ref, plus the pure hydrate (ledger rows → model)
// and toDTO (model → screen snapshot) codecs. Split out of AssistantRoute so
// that cohesive route stays under the file-size cap while gaining the Wave 1
// transcript affordances (copy, feedback, regenerate/retry pager, timestamps).

import type { AsstMsgDTO, AsstUsageDTO } from '../../screen-contracts.js';
import { richAnswerHtml } from './assistantRich.js';

export interface AsstToolCall {
  id: string;
  tool: string;
  sql?: string;
  state: 'run' | 'ok' | 'error';
  totalRows?: number;
  durationMs?: number;
  errorText?: string;
}
export interface AsstAttachment {
  hash: string;
  mime: string;
  filename?: string;
  sizeBytes: number;
}
/** One prior attempt of a regenerated answer — a sibling in the "<2/2>" pager. */
export interface Attempt {
  turnId: string;
  text: string;
  error?: boolean;
  feedback: 'up' | 'down' | null;
  usage?: AsstUsageDTO;
}
export type AsstMsg =
  | { kind: 'user'; text: string; attachments?: AsstAttachment[]; createdAt?: number }
  /** Live-only streaming reasoning row (issue #420, Wave 2). */
  | { kind: 'thinking'; text: string; streaming?: boolean }
  /** Live-only runner notice (issue #420, Wave 6) — e.g. dropped-PDF warning. */
  | { kind: 'notice'; level: 'warn' | 'info'; text: string }
  | {
      kind: 'ai';
      text: string;
      error?: boolean;
      streaming?: boolean;
      /** Reconnect catch-up in progress after a mid-turn drop (issue #420). */
      catchingUp?: boolean;
      createdAt?: number;
      /** Turn id of the shown answer — feedback/regenerate target. */
      turnId?: string;
      feedback?: 'up' | 'down' | null;
      /** Token/cost usage for the shown answer's turn (issue #420, Wave 2). */
      usage?: AsstUsageDTO;
      /** Retry siblings (oldest→newest); when set, `activeAttempt` selects one. */
      attempts?: Attempt[];
      activeAttempt?: number;
      /** Error bubble: the failed user text to resend + the retry-of turn id. */
      failedText?: string;
      retryOf?: string;
      /** Idempotency key of the failed send — REUSED on one-tap resend so the
       *  retry replays a completed turn instead of double-running it (#420). */
      idempotencyKey?: string;
      /** The failed send happened while the browser was offline (issue #420). */
      offline?: boolean;
    }
  | { kind: 'tools'; calls: AsstToolCall[] };

/** A file the composer has uploaded (or is uploading) ahead of the next send. */
export interface PendingAttachment {
  localId: string;
  filename: string;
  sizeBytes: number;
  mime: string;
  state: 'uploading' | 'ready' | 'error';
  errorText?: string;
  ref?: AsstAttachment;
  /** Local object-URL preview for an image attachment (issue #420, Wave 2). */
  previewUrl?: string;
}

/** The active attempt of an AI message with a retry pager, or null when plain. */
export function activeAttemptOf(msg: Extract<AsstMsg, { kind: 'ai' }>): Attempt | null {
  const attempts = msg.attempts;
  if (!attempts?.length) return null;
  const i = Math.min(Math.max(msg.activeAttempt ?? attempts.length - 1, 0), attempts.length - 1);
  return attempts[i] ?? null;
}

/** Rebuild the message model from the ledger transcript rows (GET session). */
export function hydrateMessages(
  rows: Array<{ payload: CentraidConversationHistoryMessage; createdAt: number }>,
): AsstMsg[] {
  const out: AsstMsg[] = [];
  for (const { payload, createdAt } of rows) {
    if (payload.kind === 'user') {
      out.push({
        kind: 'user',
        text: payload.text ?? '',
        createdAt,
        ...(payload.attachments?.length
          ? {
              attachments: payload.attachments.map((a) => ({
                hash: a.hash,
                mime: a.mime,
                ...(a.filename ? { filename: a.filename } : {}),
                sizeBytes: a.sizeBytes,
              })),
            }
          : {}),
      });
    } else if (payload.kind === 'ai') {
      const msg: Extract<AsstMsg, { kind: 'ai' }> = {
        kind: 'ai',
        text: payload.text ?? '',
        createdAt,
        ...(payload.error ? { error: true } : {}),
        ...(payload.turnId ? { turnId: payload.turnId } : {}),
        ...(payload.feedback ? { feedback: payload.feedback } : {}),
        ...(payload.usage ? { usage: payload.usage } : {}),
      };
      if (payload.retry?.attempts?.length) {
        msg.attempts = payload.retry.attempts.map((a) => ({
          turnId: a.turnId,
          text: a.text,
          ...(a.error ? { error: true } : {}),
          feedback: a.feedback ?? null,
          ...(a.usage ? { usage: a.usage } : {}),
        }));
        msg.activeAttempt = msg.attempts.length - 1;
      }
      out.push(msg);
    } else if (payload.kind === 'tool') {
      const call: AsstToolCall = {
        id: payload.id ?? String(out.length),
        tool: payload.tool ?? 'vault_sql',
        ...(payload.sql ? { sql: payload.sql } : {}),
        state: payload.state === 'ok' ? 'ok' : 'error',
        ...(payload.state !== 'ok' && payload.errorText ? { errorText: payload.errorText } : {}),
      };
      const result = payload.result as { totalRows?: number; durationMs?: number } | undefined;
      if (result && typeof result.totalRows === 'number') call.totalRows = result.totalRows;
      if (result && typeof result.durationMs === 'number') call.durationMs = result.durationMs;
      const last = out.at(-1);
      if (last?.kind === 'tools') last.calls.push(call);
      else out.push({ kind: 'tools', calls: [call] });
    }
  }
  return out;
}

/** Derive the screen DTO for one model message. `isLastAi` gates regenerate. */
export function msgToDTO(msg: AsstMsg, isLastAnswer: boolean): AsstMsgDTO {
  if (msg.kind === 'user') {
    return {
      kind: 'user',
      text: msg.text,
      ...(msg.createdAt ? { createdAt: msg.createdAt } : {}),
      ...(msg.attachments?.length
        ? {
            attachments: msg.attachments.map((a) => ({
              hash: a.hash,
              filename: a.filename ?? 'Attachment',
              mime: a.mime,
              sizeBytes: a.sizeBytes,
            })),
          }
        : {}),
    };
  }
  if (msg.kind === 'tools') {
    const n = msg.calls.length;
    const running = msg.calls.some((c) => c.state === 'run');
    const failed = msg.calls.filter((c) => c.state === 'error').length;
    const ms = msg.calls.reduce((a, c) => a + (c.durationMs ?? 0), 0);
    const label = running
      ? 'querying the vault…'
      : `${n} ${n === 1 ? 'query' : 'queries'}${ms ? ` · ${ms}ms` : ''}${failed ? ` · ${failed} failed` : ''}`;
    return {
      kind: 'tools',
      label,
      calls: msg.calls.map((c) => ({
        tool: c.tool,
        ...(c.sql ? { sql: c.sql } : {}),
        state: c.state,
        meta:
          c.state === 'error'
            ? (c.errorText ?? 'failed')
            : c.state === 'ok'
              ? `${c.totalRows ?? '?'} rows${c.durationMs ? ` · ${c.durationMs}ms` : ''}`
              : 'running…',
      })),
    };
  }
  if (msg.kind === 'thinking')
    return { kind: 'thinking', text: msg.text, streaming: !!msg.streaming };
  if (msg.kind === 'notice') return { kind: 'notice', level: msg.level, text: msg.text };
  if (msg.streaming)
    return {
      kind: 'ai',
      streaming: true,
      text: msg.text,
      ...(msg.catchingUp ? { catchingUp: true } : {}),
    };
  // Final AI answer — resolve the shown attempt for the retry pager.
  const active = activeAttemptOf(msg);
  const text = active ? active.text : msg.text;
  const error = active ? Boolean(active.error) : Boolean(msg.error);
  const turnId = active ? active.turnId : msg.turnId;
  const feedback = active ? active.feedback : (msg.feedback ?? null);
  const usage = active ? active.usage : msg.usage;
  return {
    kind: 'ai',
    streaming: false,
    html: richAnswerHtml(text),
    error,
    copyText: text,
    ...(msg.createdAt ? { createdAt: msg.createdAt } : {}),
    ...(turnId ? { turnId } : {}),
    ...(usage ? { usage } : {}),
    feedback,
    ...(msg.attempts?.length
      ? {
          retry: {
            index: (msg.activeAttempt ?? msg.attempts.length - 1) + 1,
            count: msg.attempts.length,
          },
        }
      : {}),
    ...(isLastAnswer && !error && turnId ? { canRegenerate: true } : {}),
    ...(error && msg.failedText !== undefined ? { canRetry: true } : {}),
    ...(error && msg.offline ? { offline: true } : {}),
  };
}
