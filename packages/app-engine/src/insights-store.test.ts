import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeRuntimeDbProvider, makeAnalyticsDbProvider } from './gateway-db.js';
import { AnalyticsStore } from './analytics-store.js';
import { AgentRunsStore } from './agent-runs-store.js';
import { InsightsStore, INSIGHTS_QUOTA_TOKENS } from './insights-store.js';

/**
 * `runs` writes to a run ledger and — because it is constructed WITH an
 * `AnalyticsStore` — write-throughs each finished run's summary to the
 * central analytics DB. `insights` reads only that central DB.
 */
function setup(): { runs: AgentRunsStore; insights: InsightsStore } {
  const dir = mkdtempSync(join(tmpdir(), 'centraid-insights-'));
  const ledger = makeRuntimeDbProvider(join(dir, 'runtime.sqlite'));
  const analyticsProvider = makeAnalyticsDbProvider(join(dir, 'analytics.sqlite'));
  const analytics = new AnalyticsStore(analyticsProvider);
  return {
    runs: new AgentRunsStore(ledger, analytics),
    insights: new InsightsStore(analyticsProvider),
  };
}

/** Insert a finished run with one step node (model + tokens). For an
 *  automation run, `automationRef` is its `<appId>/<id>` handle — the
 *  write-through derives the owning app id from it. Returns the run id. */
function seedRun(
  runs: AgentRunsStore,
  opts: {
    kind: 'automation' | 'chat' | 'build';
    automationRef?: string;
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
  runs.insertRun({
    runId,
    kind: opts.kind,
    triggerKind: opts.kind === 'chat' ? 'interactive' : 'manual',
    ...(opts.automationRef ? { automationId: opts.automationRef } : {}),
    ...(opts.retryOf ? { retryOf: opts.retryOf } : {}),
    startedAt,
  });
  runs.insertNode({
    nodeId: randomUUID(),
    runId,
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
  // finishRun rolls the step nodes up into runs.total_* AND
  // write-throughs the summary to the central analytics DB.
  runs.finishRun({ runId, endedAt: startedAt + 200, ok: true });
  return runId;
}

describe('InsightsStore', () => {
  it('returns an all-zero summary for an empty ledger', () => {
    const { insights } = setup();
    const s = insights.summary();
    assert.equal(s.kpis.generations, 0);
    assert.equal(s.kpis.totalTokens, 0);
    assert.equal(s.kpis.totalCostUsd, 0);
    assert.equal(s.kpis.appsTouched, 0);
    assert.equal(s.kpis.quotaTokens, INSIGHTS_QUOTA_TOKENS);
    assert.deepEqual(s.daily, []);
    assert.deepEqual(s.byAutomation, []);
    assert.deepEqual(s.byModel, []);
    assert.deepEqual(s.recent, []);
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
    assert.equal(s.kpis.generations, 2);
    assert.equal(s.kpis.totalTokens, 1800);
    assert.equal(s.kpis.totalCostUsd, 0.03);
    // Only the automation run carries an owning app; chat has none.
    assert.equal(s.kpis.appsTouched, 1);
    assert.equal(s.kpis.retries, 0);
    assert.ok(s.kpis.forecastCostUsd >= 0);
  });

  it('counts distinct owning apps across automation runs', () => {
    const { runs, insights } = setup();
    seedRun(runs, { kind: 'automation', automationRef: 'auto.todos/digest', inputTokens: 10 });
    seedRun(runs, { kind: 'automation', automationRef: 'auto.habits/nudge', inputTokens: 10 });
    seedRun(runs, { kind: 'automation', automationRef: 'auto.todos/sweep', inputTokens: 10 });
    assert.equal(insights.summary().kpis.appsTouched, 2);
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
    assert.equal(s.kpis.generations, 2);
    assert.equal(s.kpis.retries, 1);
  });

  it('groups by automation, collapsing chat into a synthetic bucket', () => {
    const { runs, insights } = setup();
    seedRun(runs, { kind: 'automation', automationRef: 'auto.x/auto-1', inputTokens: 500 });
    seedRun(runs, { kind: 'chat', inputTokens: 300 });
    const s = insights.summary();
    const chat = s.byAutomation.find((r) => r.kind === 'chat');
    const auto = s.byAutomation.find((r) => r.kind === 'automation');
    assert.ok(chat, 'expected a chat bucket');
    assert.equal(chat.key, 'chat');
    assert.equal(chat.label, 'Chat');
    assert.equal(chat.tokens, 300);
    assert.ok(auto, 'expected an automation row');
    assert.equal(auto.key, 'auto.x/auto-1');
    assert.equal(auto.tokens, 500);
  });

  it('groups by each run’s dominant model', () => {
    const { runs, insights } = setup();
    seedRun(runs, { kind: 'chat', model: 'claude-sonnet-4-5', inputTokens: 100, outputTokens: 50 });
    seedRun(runs, { kind: 'chat', model: 'claude-sonnet-4-5', inputTokens: 200, outputTokens: 80 });
    seedRun(runs, { kind: 'chat', model: 'gpt-5-codex', inputTokens: 40 });
    const s = insights.summary();
    const sonnet = s.byModel.find((m) => m.model === 'claude-sonnet-4-5');
    assert.ok(sonnet);
    assert.equal(sonnet.runs, 2);
    assert.equal(sonnet.tokens, 430);
    assert.equal(s.byModel.length, 2);
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
    assert.equal(s.recent.length, 2);
    assert.equal(s.recent[0]!.kind, 'chat');
  });

  it('excludes runs outside the window', () => {
    const { runs, insights } = setup();
    // 60 days ago — outside a 30-day window.
    seedRun(runs, { kind: 'chat', inputTokens: 999, startedAt: Date.now() - 60 * 86_400_000 });
    seedRun(runs, { kind: 'chat', inputTokens: 5, startedAt: Date.now() });
    const s = insights.summary({ windowDays: 30 });
    assert.equal(s.kpis.generations, 1);
    assert.equal(s.kpis.totalTokens, 5);
  });

  it('builds a daily series grouped by date', () => {
    const { runs, insights } = setup();
    seedRun(runs, { kind: 'chat', inputTokens: 100, outputTokens: 20 });
    seedRun(runs, { kind: 'chat', inputTokens: 30 });
    const s = insights.summary();
    assert.equal(s.daily.length, 1);
    assert.equal(s.daily[0]!.tokens, 150);
    assert.equal(s.daily[0]!.runs, 2);
    assert.match(s.daily[0]!.date, /^\d{4}-\d{2}-\d{2}$/);
  });
});
