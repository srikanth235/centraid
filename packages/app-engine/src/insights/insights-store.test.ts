import { tempDirSync } from '@centraid/test-kit/temp-dir';
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { makeJournalDbProvider, openJournalDb } from '../stores/gateway-db.js';
import { ConversationStore } from '../conversation/store.js';
import { InsightsStore } from './insights-store.js';

/**
 * `runs` writes the conversation ledger; `insights` reads the `run_summary`
 * VIEW that derives from it.
 */
function setup(): { runs: ConversationStore; insights: InsightsStore } {
  const dir = tempDirSync('centraid-insights-');
  const ledger = makeJournalDbProvider(join(dir, 'journal.db'));
  return {
    runs: new ConversationStore(ledger),
    insights: new InsightsStore(ledger),
  };
}

/** Insert a finished turn with one step item under a conversation of the given kind. */
function seedRun(
  runs: ConversationStore,
  opts: {
    kind: 'automation' | 'chat' | 'build';
    automationRef?: string;
    automationName?: string;
    model?: string;
    provider?: string;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    costSource?: 'agent' | 'estimated';
    retryOf?: string;
    startedAt?: number;
    ok?: boolean;
  },
): string {
  const runId = randomUUID();
  const startedAt = opts.startedAt ?? Date.now();
  let conversationId: string;
  if (opts.kind === 'automation' && opts.automationRef) {
    conversationId = runs.ensureAutomationConversation(
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
    ok: opts.ok !== false,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.inputTokens !== undefined ? { inputTokens: opts.inputTokens } : {}),
    ...(opts.outputTokens !== undefined ? { outputTokens: opts.outputTokens } : {}),
    ...(opts.costUsd !== undefined ? { costUsd: opts.costUsd } : {}),
    ...(opts.costSource ? { costSource: opts.costSource } : {}),
    startedAt,
    endedAt: startedAt + 100,
    durationMs: 100,
  });
  runs.finishTurn({ turnId: runId, endedAt: startedAt + 200, ok: opts.ok !== false });
  return runId;
}

describe('InsightsStore (#514)', () => {
  it('returns an all-zero summary for an empty ledger without a fake quota', () => {
    const { insights } = setup();
    const s = insights.summary();
    expect(s.kpis.generations).toBe(0);
    expect(s.kpis.totalTokens).toBe(0);
    expect(s.kpis.totalCostUsd).toBe(0);
    expect(s.kpis.agentReportedCostUsd).toBe(0);
    expect(s.kpis.estimatedCostUsd).toBe(0);
    expect(s.kpis.appsTouched).toBe(0);
    expect(s.kpis.unpricedRuns).toBe(0);
    expect(s.kpis.unreportedRuns).toBe(0);
    expect('quotaTokens' in s.kpis).toBe(false);
    expect(s.daily).toEqual([]);
    expect(s.bySource).toEqual([]);
    expect(s.byRunner).toEqual([]);
    expect(s.byModel).toEqual([]);
    expect(s.recent).toEqual([]);
  });

  it('splits agent-reported vs estimated cost and counts unpriced', () => {
    const { runs, insights } = setup();
    seedRun(runs, {
      kind: 'chat',
      model: 'claude-haiku-4-5',
      provider: 'claude-code',
      inputTokens: 100,
      costUsd: 0.05,
      costSource: 'agent',
    });
    seedRun(runs, {
      kind: 'chat',
      model: 'claude-haiku-4-5',
      provider: 'claude-code',
      inputTokens: 100,
      costUsd: 0.01,
      costSource: 'estimated',
    });
    seedRun(runs, {
      kind: 'chat',
      model: 'some-unknown-model',
      provider: 'gemini',
      inputTokens: 100,
    });

    const s = insights.summary();
    expect(s.kpis.generations).toBe(3);
    expect(s.kpis.agentReportedCostUsd).toBeCloseTo(0.05, 4);
    expect(s.kpis.estimatedCostUsd).toBeCloseTo(0.01, 4);
    expect(s.kpis.unpricedRuns).toBe(1);
    expect(s.kpis.totalCostUsd).toBeCloseTo(0.06, 4);
  });

  it('counts unreported runs and failed spend', () => {
    const { runs, insights } = setup();
    seedRun(runs, {
      kind: 'chat',
      model: 'm',
      provider: 'codex',
      inputTokens: 50,
      costUsd: 0.02,
      costSource: 'agent',
    });
    seedRun(runs, { kind: 'chat', model: 'm', provider: 'codex' });
    seedRun(runs, {
      kind: 'chat',
      model: 'm',
      provider: 'codex',
      inputTokens: 10,
      costUsd: 0.03,
      costSource: 'agent',
      ok: false,
    });
    const s = insights.summary();
    expect(s.kpis.unreportedRuns).toBe(1);
    expect(s.kpis.failedRuns).toBe(1);
    expect(s.kpis.failedCostUsd).toBeCloseTo(0.03, 4);
  });

  it('ranks bySource and byRunner by cost and surfaces attention', () => {
    const { runs, insights } = setup();
    seedRun(runs, {
      kind: 'automation',
      automationRef: 'app/big',
      automationName: 'Big',
      provider: 'claude-code',
      model: 'm',
      inputTokens: 100,
      costUsd: 1,
      costSource: 'agent',
    });
    seedRun(runs, {
      kind: 'chat',
      provider: 'gemini',
      model: 'm',
      inputTokens: 500,
      costUsd: 0.1,
      costSource: 'agent',
    });
    const s = insights.summary();
    expect(s.bySource[0]?.key).toBe('app/big');
    expect(s.bySource[0]?.costUsd).toBeCloseTo(1, 4);
    expect(s.byRunner[0]?.provider).toBe('claude-code');
    expect(s.attention?.key).toBe('app/big');
    expect(s.attention!.share).toBeGreaterThanOrEqual(0.4);
  });

  it('recent prefers failed then high-cost runs', () => {
    const { runs, insights } = setup();
    const t = Date.now();
    seedRun(runs, {
      kind: 'chat',
      inputTokens: 1,
      costUsd: 0.001,
      costSource: 'agent',
      startedAt: t,
      model: 'm',
      provider: 'p',
    });
    seedRun(runs, {
      kind: 'chat',
      inputTokens: 10,
      costUsd: 0.5,
      costSource: 'agent',
      startedAt: t + 1,
      model: 'm',
      provider: 'p',
      ok: false,
    });
    const s = insights.summary();
    expect(s.recent[0]?.ok).toBe(false);
    expect(s.recent[0]?.costUsd).toBeCloseTo(0.5, 4);
  });

  it('windowDays filters old runs', () => {
    const { runs, insights } = setup();
    seedRun(runs, {
      kind: 'chat',
      inputTokens: 999,
      startedAt: Date.now() - 60 * 86_400_000,
      model: 'm',
      provider: 'p',
      costUsd: 1,
      costSource: 'agent',
    });
    seedRun(runs, {
      kind: 'chat',
      inputTokens: 5,
      startedAt: Date.now(),
      model: 'm',
      provider: 'p',
      costUsd: 0.01,
      costSource: 'agent',
    });
    const s = insights.summary({ windowDays: 30 });
    expect(s.kpis.totalTokens).toBe(5);
  });

  it('daily series and peakDay are populated', () => {
    const { runs, insights } = setup();
    const now = Date.now();
    seedRun(runs, {
      kind: 'chat',
      inputTokens: 100,
      costUsd: 0.1,
      costSource: 'agent',
      startedAt: now,
      model: 'm',
      provider: 'p',
    });
    seedRun(runs, {
      kind: 'chat',
      inputTokens: 500,
      costUsd: 0.5,
      costSource: 'agent',
      startedAt: now - 86_400_000,
      model: 'm',
      provider: 'p',
    });
    const s = insights.summary();
    expect(s.daily.length).toBeGreaterThanOrEqual(1);
    expect(s.peakDay).toBeDefined();
    expect(s.peakDay!.costUsd).toBeGreaterThanOrEqual(0.1);
  });

  it('rolls tokens across chat and automation', () => {
    const { runs, insights } = setup();
    seedRun(runs, {
      kind: 'automation',
      automationRef: 'auto.todos/digest',
      model: 'claude-sonnet-4-5',
      provider: 'claude-code',
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.02,
      costSource: 'estimated',
    });
    seedRun(runs, {
      kind: 'chat',
      model: 'gpt-5-codex',
      provider: 'codex',
      inputTokens: 200,
      outputTokens: 100,
      costUsd: 0.01,
      costSource: 'agent',
    });
    const s = insights.summary();
    expect(s.kpis.totalTokens).toBe(1800);
    expect(s.kpis.generations).toBe(2);
  });
});

function setupWithDb(): {
  runs: ConversationStore;
  insights: InsightsStore;
  db: DatabaseSync;
} {
  const dir = tempDirSync('centraid-insights-digest-');
  const dbPath = join(dir, 'journal.db');
  const db = openJournalDb(dbPath);
  const ledger = makeJournalDbProvider(dbPath);
  return {
    runs: new ConversationStore(ledger),
    insights: new InsightsStore(ledger),
    db,
  };
}

function seedDigest(
  db: DatabaseSync,
  d: {
    conversationId: string;
    kind?: string;
    automationRef?: string | null;
    lastEndedAt: number;
    runCount?: number;
    tokens?: number;
    cost?: number;
    modelsJson?: string;
  },
): void {
  db.prepare(
    `INSERT INTO conversation_digest (
       conversation_id, kind, automation_ref, app_id, automation_name,
       first_started_at, last_ended_at, run_count, retry_count,
       total_input_tokens, total_output_tokens, total_cache_read_tokens, total_cache_write_tokens,
       total_cost_usd, step_count, tool_count, models_json, updated_at
     ) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, 0, ?, 0, 0, 0, ?, 0, 0, ?, ?)`,
  ).run(
    d.conversationId,
    d.kind ?? 'chat',
    d.automationRef ?? null,
    d.lastEndedAt - 1000,
    d.lastEndedAt,
    d.runCount ?? 1,
    d.tokens ?? 0,
    d.cost ?? 0,
    d.modelsJson ?? '[]',
    Date.now(),
  );
}

describe('InsightsStore digest union (#438 + #514)', () => {
  it('unions digest tokens/cost into KPIs for long windows', () => {
    const { runs, insights, db } = setupWithDb();
    const now = Date.now();
    seedRun(runs, {
      kind: 'chat',
      inputTokens: 200,
      outputTokens: 100,
      costUsd: 0.01,
      costSource: 'agent',
      startedAt: now,
      model: 'm',
      provider: 'p',
    });
    const archConv = runs.createConversation({ kind: 'chat', userId: 'u', id: 'arch-1' });
    seedDigest(db, {
      conversationId: archConv.id,
      lastEndedAt: now - 10 * 86_400_000,
      tokens: 1000,
      cost: 0.05,
      runCount: 3,
      modelsJson: JSON.stringify([{ model: 'old-m', runs: 3, tokens: 1000, cost: 0.05 }]),
    });
    const s = insights.summary({ windowDays: 365 });
    expect(s.kpis.totalTokens).toBe(300 + 1000);
    expect(s.kpis.generations).toBe(1 + 3);
    // bySource includes live + digest
    expect(s.bySource.some((r) => r.kind === 'chat')).toBe(true);
  });
});
