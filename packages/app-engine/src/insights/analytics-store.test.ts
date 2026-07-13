import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeJournalDbProvider } from '../stores/gateway-db.js';
import { ConversationStore } from '../conversation/store.js';
import { AnalyticsStore } from './analytics-store.js';

/*
 * `run_summary` is a VIEW over the ledger tables (turns ⋈ conversations +
 * dominant model from items) — so these tests seed through the ledger and
 * assert what the read-only lens derives. There is no write path to test.
 */
function setup(): { runs: ConversationStore; analytics: AnalyticsStore } {
  const dir = mkdtempSync(join(tmpdir(), 'centraid-analytics-'));
  const ledger = makeJournalDbProvider(join(dir, 'journal.db'));
  return { runs: new ConversationStore(ledger), analytics: new AnalyticsStore(ledger) };
}

interface SeedOptions {
  runId?: string;
  automationRef?: string;
  ok?: boolean;
  error?: string;
  model?: string;
  startedAt?: number;
  inputTokens?: number;
  outputTokens?: number;
  finish?: boolean;
}

/** One automation fire appended to its stable conversation. */
function seedFire(runs: ConversationStore, opts: SeedOptions = {}): string {
  const runId = opts.runId ?? randomUUID();
  const ref = opts.automationRef ?? 'auto.todos/digest';
  const startedAt = opts.startedAt ?? 1_000;
  const conversationId = runs.ensureAutomationConversation(ref, ref.split('/')[0]!);
  runs.insertTurn({ turnId: runId, conversationId, triggerKind: 'manual', startedAt });
  runs.insertItem({
    itemId: randomUUID(),
    turnId: runId,
    ordinal: 0,
    kind: 'step',
    ok: true,
    model: opts.model ?? 'claude-sonnet-4-5',
    inputTokens: opts.inputTokens ?? 100,
    outputTokens: opts.outputTokens ?? 50,
    startedAt,
    endedAt: startedAt + 100,
    durationMs: 100,
  });
  if (opts.finish !== false) {
    runs.finishTurn({
      turnId: runId,
      endedAt: startedAt + 200,
      ok: opts.ok ?? true,
      ...(opts.error ? { error: opts.error } : {}),
    });
  }
  return runId;
}

describe('AnalyticsStore (read-only lens over the run_summary view)', () => {
  it('derives a finished run: ref, owning app id, rollups, dominant model', () => {
    const { runs, analytics } = setup();
    const runId = seedFire(runs, { inputTokens: 100, outputTokens: 50 });
    const got = analytics.getSummary(runId);
    expect(got?.kind).toBe('automation');
    expect(got?.automationRef).toBe('auto.todos/digest');
    // The `<appId>/<id>` handle's app id is the segment before the slash.
    expect(got?.appId).toBe('auto.todos');
    expect(got?.ok).toBe(true);
    expect(got?.totalInputTokens).toBe(100);
    expect(got?.model).toBe('claude-sonnet-4-5');
  });

  it('shows only FINISHED runs — an in-flight turn is not a summary yet', () => {
    const { runs, analytics } = setup();
    const runId = seedFire(runs, { finish: false });
    expect(analytics.getSummary(runId)).toBe(undefined);
    runs.finishTurn({ turnId: runId, endedAt: 2_000, ok: false, error: 'boom' });
    const got = analytics.getSummary(runId);
    expect(got?.ok).toBe(false);
    expect(got?.error).toBe('boom');
  });

  it('lists summaries newest-first, optionally scoped to one automation', () => {
    const { runs, analytics } = setup();
    seedFire(runs, { runId: 'r1', automationRef: 'auto.a/job', startedAt: 100 });
    seedFire(runs, { runId: 'r2', automationRef: 'auto.b/job', startedAt: 300 });
    seedFire(runs, { runId: 'r3', automationRef: 'auto.a/job', startedAt: 200 });
    expect(analytics.listSummaries().map((r) => r.runId)).toEqual(['r2', 'r3', 'r1']);
    expect(analytics.listSummaries({ automationRef: 'auto.a/job' }).map((r) => r.runId)).toEqual([
      'r3',
      'r1',
    ]);
  });

  it('reflects ledger mutations: turn pins and automation deletes', () => {
    const { runs, analytics } = setup();
    seedFire(runs, { runId: 'r1', automationRef: 'auto.a/job' });
    seedFire(runs, { runId: 'r2', automationRef: 'auto.b/job' });
    expect(analytics.getSummary('r1')?.pinned).toBe(false);
    runs.setTurnPinned('r1', true);
    expect(analytics.getSummary('r1')?.pinned).toBe(true);
    runs.deleteAutomationData('auto.a/job');
    expect(analytics.getSummary('r1')).toBe(undefined);
    expect(analytics.getSummary('r2')).toBeTruthy();
  });

  it('picks the dominant model by token volume across step items', () => {
    const { runs, analytics } = setup();
    const runId = randomUUID();
    const conversationId = runs.ensureAutomationConversation('auto.a/job', 'auto.a');
    runs.insertTurn({ turnId: runId, conversationId, triggerKind: 'manual', startedAt: 100 });
    for (const [model, tokens, ordinal] of [
      ['small-model', 10, 0],
      ['big-model', 900, 1],
    ] as const) {
      runs.insertItem({
        itemId: randomUUID(),
        turnId: runId,
        ordinal,
        kind: 'step',
        ok: true,
        model,
        inputTokens: tokens,
        outputTokens: tokens,
        startedAt: 100,
        endedAt: 200,
        durationMs: 100,
      });
    }
    runs.finishTurn({ turnId: runId, endedAt: 300, ok: true });
    expect(analytics.getSummary(runId)?.model).toBe('big-model');
  });
});
