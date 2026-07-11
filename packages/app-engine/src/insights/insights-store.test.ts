import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeJournalDbProvider } from '../stores/gateway-db.js';
import { ConversationStore } from '../conversation/store.js';
import { InsightsStore, INSIGHTS_QUOTA_TOKENS } from './insights-store.js';

/**
 * `runs` writes the conversation ledger; `insights` reads the `run_summary`
 * VIEW that derives from it (same file — `kind`/`app_id` come from the
 * owning conversation, the dominant model from the step items).
 */
function setup(): { runs: ConversationStore; insights: InsightsStore } {
  const dir = mkdtempSync(join(tmpdir(), 'centraid-insights-'));
  const ledger = makeJournalDbProvider(join(dir, 'journal.db'));
  return {
    runs: new ConversationStore(ledger),
    insights: new InsightsStore(ledger),
  };
}

/** Insert a finished turn with one step item (model + tokens), under a
 *  conversation of the given kind. For an automation, each fire is its own
 *  execution conversation tagged with the `<appId>/<id>` ref — the
 *  view derives the owning app id from it. Returns the turn id. */
function seedRun(
  runs: ConversationStore,
  opts: {
    kind: 'automation' | 'chat' | 'build';
    automationRef?: string;
    automationName?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    retryOf?: string;
    startedAt?: number;
  },
): string {
  const runId = randomUUID();
  const startedAt = opts.startedAt ?? Date.now();
  let conversationId: string;
  if (opts.kind === 'automation' && opts.automationRef) {
    // Each fire is its own execution conversation, grouped by the automation ref.
    conversationId = randomUUID();
    runs.createAutomationRun(
      conversationId,
      opts.automationRef,
      opts.automationRef.split('/')[0],
      opts.automationName,
    );
  } else {
    conversationId = runs.createConversation({ kind: opts.kind, userId: 'u' }).id;
  }
  runs.insertTurn({
    turnId: runId,
    conversationId,
    triggerKind: opts.kind === 'chat' ? 'interactive' : 'manual',
    ...(opts.retryOf ? { retryOf: opts.retryOf } : {}),
    startedAt,
  });
  runs.insertItem({
    itemId: randomUUID(),
    turnId: runId,
    ordinal: 0,
    kind: 'step',
    ok: true,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.inputTokens !== undefined ? { inputTokens: opts.inputTokens } : {}),
    ...(opts.outputTokens !== undefined ? { outputTokens: opts.outputTokens } : {}),
    ...(opts.costUsd !== undefined ? { costUsd: opts.costUsd } : {}),
    startedAt,
    endedAt: startedAt + 100,
    durationMs: 100,
  });
  // finishTurn rolls the step items up into turns.total_*; the finished
  // turn then appears in the run_summary view.
  runs.finishTurn({ turnId: runId, endedAt: startedAt + 200, ok: true });
  return runId;
}

describe('InsightsStore', () => {
  it('returns an all-zero summary for an empty ledger', () => {
    const { insights } = setup();
    const s = insights.summary();
    expect(s.kpis.generations).toBe(0);
    expect(s.kpis.totalTokens).toBe(0);
    expect(s.kpis.totalCostUsd).toBe(0);
    expect(s.kpis.appsTouched).toBe(0);
    expect(s.kpis.quotaTokens).toBe(INSIGHTS_QUOTA_TOKENS);
    expect(s.daily).toEqual([]);
    expect(s.byAutomation).toEqual([]);
    expect(s.byModel).toEqual([]);
    expect(s.recent).toEqual([]);
  });

  it('rolls up KPIs across chat and automation runs', () => {
    const { runs, insights } = setup();
    seedRun(runs, {
      kind: 'automation',
      automationRef: 'auto.todos/digest',
      model: 'claude-sonnet-4-5',
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.02,
    });
    seedRun(runs, {
      kind: 'chat',
      model: 'gpt-5-codex',
      inputTokens: 200,
      outputTokens: 100,
      costUsd: 0.01,
    });
    const s = insights.summary();
    expect(s.kpis.generations).toBe(2);
    expect(s.kpis.totalTokens).toBe(1800);
    expect(s.kpis.totalCostUsd).toBe(0.03);
    // Only the automation run carries an owning app; chat has none.
    expect(s.kpis.appsTouched).toBe(1);
    expect(s.kpis.retries).toBe(0);
    expect(s.kpis.forecastCostUsd >= 0).toBeTruthy();
  });

  it('counts distinct owning apps across automation runs', () => {
    const { runs, insights } = setup();
    seedRun(runs, { kind: 'automation', automationRef: 'auto.todos/digest', inputTokens: 10 });
    seedRun(runs, { kind: 'automation', automationRef: 'auto.habits/nudge', inputTokens: 10 });
    seedRun(runs, { kind: 'automation', automationRef: 'auto.todos/sweep', inputTokens: 10 });
    expect(insights.summary().kpis.appsTouched).toBe(2);
  });

  it('counts retries via retry_of', () => {
    const { runs, insights } = setup();
    const first = seedRun(runs, {
      kind: 'automation',
      automationRef: 'auto.a/job',
      inputTokens: 10,
    });
    seedRun(runs, {
      kind: 'automation',
      automationRef: 'auto.a/job',
      inputTokens: 10,
      retryOf: first,
    });
    const s = insights.summary();
    expect(s.kpis.generations).toBe(2);
    expect(s.kpis.retries).toBe(1);
  });

  it('groups by automation, collapsing chat into a synthetic bucket', () => {
    const { runs, insights } = setup();
    seedRun(runs, { kind: 'automation', automationRef: 'auto.x/auto-1', inputTokens: 500 });
    seedRun(runs, { kind: 'chat', inputTokens: 300 });
    const s = insights.summary();
    const chat = s.byAutomation.find((r) => r.kind === 'chat');
    const auto = s.byAutomation.find((r) => r.kind === 'automation');
    expect(chat).toBeTruthy();
    expect(chat!.key).toBe('chat');
    expect(chat!.label).toBe('Chat');
    expect(chat!.tokens).toBe(300);
    expect(auto).toBeTruthy();
    expect(auto!.key).toBe('auto.x/auto-1');
    expect(auto!.tokens).toBe(500);
  });

  it('carries the run-recorded automation name on byAutomation + recent rows (orphaned-run fallback)', () => {
    const { runs, insights } = setup();
    seedRun(runs, {
      kind: 'automation',
      automationRef: 'auto.x/auto-1',
      automationName: 'Auto One',
      inputTokens: 500,
    });
    // A run recorded before this field existed carries no name.
    seedRun(runs, { kind: 'automation', automationRef: 'auto.y/auto-2', inputTokens: 10 });
    const s = insights.summary();
    const named = s.byAutomation.find((r) => r.key === 'auto.x/auto-1');
    const unnamed = s.byAutomation.find((r) => r.key === 'auto.y/auto-2');
    expect(named?.automationName).toBe('Auto One');
    expect(unnamed?.automationName).toBeUndefined();
    const namedRecent = s.recent.find((r) => r.automationRef === 'auto.x/auto-1');
    expect(namedRecent?.automationName).toBe('Auto One');
  });

  it('groups by each run’s dominant model', () => {
    const { runs, insights } = setup();
    seedRun(runs, { kind: 'chat', model: 'claude-sonnet-4-5', inputTokens: 100, outputTokens: 50 });
    seedRun(runs, { kind: 'chat', model: 'claude-sonnet-4-5', inputTokens: 200, outputTokens: 80 });
    seedRun(runs, { kind: 'chat', model: 'gpt-5-codex', inputTokens: 40 });
    const s = insights.summary();
    const sonnet = s.byModel.find((m) => m.model === 'claude-sonnet-4-5');
    expect(sonnet).toBeTruthy();
    expect(sonnet!.runs).toBe(2);
    expect(sonnet!.tokens).toBe(430);
    expect(s.byModel.length).toBe(2);
  });

  it('returns recent activity newest-first', () => {
    const { runs, insights } = setup();
    seedRun(runs, {
      kind: 'automation',
      automationRef: 'auto.a/job',
      startedAt: Date.now() - 60_000,
    });
    seedRun(runs, { kind: 'chat', startedAt: Date.now() });
    const s = insights.summary();
    expect(s.recent.length).toBe(2);
    expect(s.recent[0]!.kind).toBe('chat');
  });

  it('excludes runs outside the window', () => {
    const { runs, insights } = setup();
    // 60 days ago — outside a 30-day window.
    seedRun(runs, { kind: 'chat', inputTokens: 999, startedAt: Date.now() - 60 * 86_400_000 });
    seedRun(runs, { kind: 'chat', inputTokens: 5, startedAt: Date.now() });
    const s = insights.summary({ windowDays: 30 });
    expect(s.kpis.generations).toBe(1);
    expect(s.kpis.totalTokens).toBe(5);
  });

  it('builds a daily series grouped by date', () => {
    const { runs, insights } = setup();
    seedRun(runs, { kind: 'chat', inputTokens: 100, outputTokens: 20 });
    seedRun(runs, { kind: 'chat', inputTokens: 30 });
    const s = insights.summary();
    expect(s.daily.length).toBe(1);
    expect(s.daily[0]!.tokens).toBe(150);
    expect(s.daily[0]!.runs).toBe(2);
    expect(s.daily[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
