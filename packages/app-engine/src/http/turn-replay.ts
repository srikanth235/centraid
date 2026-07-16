/*
 * Idempotency replay (issue #420, Wave 6). When a turn POST arrives with an
 * `idempotencyKey` that already names a recorded turn on the conversation, the
 * route must NOT re-run the model — it replays the recorded answer as a short
 * SSE stream the client consumes exactly like a fresh turn.
 *
 * `buildReplayEvents` turns a `RecordedTurnReplay` (ledger lookup) into the
 * `TurnStreamEvent` sequence to write. A completed turn replays its final text
 * (a single `assistant.delta` carrying the whole answer, then `final`, plus a
 * `usage` frame when the ledger froze token/cost rollups); an errored turn
 * replays its `error`. The driver appends the closing `event: end` frame.
 *
 * Pure + tiny so it is unit-testable without a live stream.
 */

import type { TurnStreamEvent } from '../conversation/runner.js';
import type { RecordedTurnReplay } from '../conversation/history.js';

/**
 * The ordered `TurnStreamEvent`s that replay a recorded turn. Both chat
 * surfaces already fold this shape (`assistant.start` → `assistant.delta` →
 * `usage` → `final`, or a bare `error`), so a replay renders identically to
 * the turn's original stream.
 */
export function buildReplayEvents(recorded: RecordedTurnReplay): TurnStreamEvent[] {
  const notices: TurnStreamEvent[] = (recorded.notices ?? []).map((n) => ({
    type: 'notice',
    level: n.level,
    ...(n.code !== undefined ? { code: n.code } : {}),
    message: n.message,
  }));
  if (!recorded.ok) {
    return [...notices, { type: 'error', message: recorded.error ?? 'This turn failed.' }];
  }
  const text = recorded.finalText ?? '';
  // Persisted system notes (issue #424) replay first, ahead of the answer —
  // the same order the live stream emitted them in.
  const events: TurnStreamEvent[] = [{ type: 'assistant.start' }, ...notices];
  if (text.length > 0) events.push({ type: 'assistant.delta', delta: text });
  if (recorded.usage) {
    events.push({
      type: 'usage',
      ...(recorded.usage.model !== undefined ? { model: recorded.usage.model } : {}),
      ...(recorded.usage.inputTokens !== undefined
        ? { inputTokens: recorded.usage.inputTokens }
        : {}),
      ...(recorded.usage.outputTokens !== undefined
        ? { outputTokens: recorded.usage.outputTokens }
        : {}),
    });
  }
  events.push({ type: 'final', text });
  return events;
}
