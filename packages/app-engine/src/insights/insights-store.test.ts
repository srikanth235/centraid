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
 *  conversation of the given kind. Automation turns share the conversation
 *  tagged with the `<appId>/<id>` ref. Returns the turn id. */
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
    expect(s.kpis.unpricedRuns).toBe(0);
  });

  it('counts finished runs whose cost is NULL as unpriced (#445)', () => {
    const { runs, insights } = setup();
    // Two priced runs, one left unpriced (no costUsd → total_cost_usd NULL).
    seedRun(runs, { kind: 'chat', model: 'claude-haiku-4-5', inputTokens: 100, costUsd: 0.01 });
    seedRun(runs, { kind: 'chat', model: 'claude-haiku-4-5', inputTokens: 100, costUsd: 0.01 });
    seedRun(runs, { kind: 'chat', model: 'some-unknown-model', inputTokens: 100 });

    const s = insights.summary();
    expect(s.kpis.generations).toBe(3);
    expect(s.kpis.unpricedRuns).toBe(1);
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

/**
 * #438: archived-and-pruned runs live in `conversation_digest` (one row per
 * conversation, the ARCHIVED portion only). Insights unions live `run_summary`
 * aggregates with these rollups so pruning raw rows is invisible to the
 * dashboard. These tests hand-insert digest rows (Wave 2 writes them for real)
 * and assert the union math.
 */
function setupWithDb(): {
  runs: ConversationStore;
  insights: InsightsStore;
  db: ReturnType<ReturnType<typeof makeJournalDbProvider>>;
} {
  const dir = mkdtempSync(join(tmpdir(), 'centraid-insights-digest-'));
  const ledger = makeJournalDbProvider(join(dir, 'journal.db'));
  return {
    runs: new ConversationStore(ledger),
    insights: new InsightsStore(ledger),
    db: ledger(),
  };
}

interface DigestInput {
  conversationId: string;
  kind: string;
  appId?: string | null;
  automationRef?: string | null;
  automationName?: string | null;
  lastEndedAt: number;
  firstStartedAt?: number;
  runCount: number;
  retryCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  models?: Array<{ model: string; runs: number; tokens: number; cost: number }>;
}

/** Insert a conversation_digest row (raw rows already pruned). */
function insertDigest(
  db: ReturnType<ReturnType<typeof makeJournalDbProvider>>,
  d: DigestInput,
): void {
  db.prepare(
    `INSERT INTO conversation_digest
       (conversation_id, kind, app_id, automation_ref, automation_name, title,
        first_started_at, last_ended_at, run_count, ok_count, err_count, retry_count,
        total_input_tokens, total_output_tokens, total_cache_read_tokens,
        total_cache_write_tokens, total_cost_usd, step_count, tool_count,
        models_json, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    d.conversationId,
    d.kind,
    d.appId ?? null,
    d.automationRef ?? null,
    d.automationName ?? null,
    '',
    d.firstStartedAt ?? d.lastEndedAt,
    d.lastEndedAt,
    d.runCount,
    d.runCount,
    0,
    d.retryCount ?? 0,
    d.inputTokens ?? 0,
    d.outputTokens ?? 0,
    0,
    0,
    d.costUsd ?? 0,
    0,
    0,
    JSON.stringify(d.models ?? []),
    d.lastEndedAt,
  );
}

describe('InsightsStore digest union (#438)', () => {
  it('unions archived-digest rollups into KPIs, byAutomation, byModel and daily', () => {
    const { runs, insights, db } = setupWithDb();
    const now = Date.now();
    // A live chat run (recent) — no owning app.
    seedRun(runs, {
      kind: 'chat',
      model: 'm-live',
      inputTokens: 200,
      outputTokens: 100,
      costUsd: 0.01,
      startedAt: now,
    });
    // An archived automation conversation: raw rows pruned, only a digest left.
    const conv = runs.ensureAutomationConversation('auto.todos/digest', 'auto.todos', 'Digest');
    insertDigest(db, {
      conversationId: conv,
      kind: 'automation',
      appId: 'auto.todos',
      automationRef: 'auto.todos/digest',
      automationName: 'Digest',
      lastEndedAt: now,
      runCount: 3,
      retryCount: 1,
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.05,
      models: [{ model: 'm-archived', runs: 3, tokens: 1500, cost: 0.05 }],
    });

    // 365d window so the digest's span reaches into it.
    const s = insights.summary({ windowDays: 365 });
    expect(s.kpis.generations).toBe(1 + 3);
    expect(s.kpis.totalTokens).toBe(300 + 1500);
    expect(s.kpis.retries).toBe(1);
    expect(s.kpis.totalCostUsd).toBe(0.06);
    // digest app 'auto.todos'; the live chat run carries no app.
    expect(s.kpis.appsTouched).toBe(1);

    const auto = s.byAutomation.find((r) => r.key === 'auto.todos/digest');
    expect(auto?.runs).toBe(3);
    expect(auto?.tokens).toBe(1500);
    expect(auto?.automationName).toBe('Digest');

    const archived = s.byModel.find((m) => m.model === 'm-archived');
    const live = s.byModel.find((m) => m.model === 'm-live');
    expect(archived?.runs).toBe(3);
    expect(archived?.tokens).toBe(1500);
    expect(live?.tokens).toBe(300);

    // SUM(daily.tokens) ties to the KPI total (same window filter both places).
    const dailyTokens = s.daily.reduce((acc, d) => acc + d.tokens, 0);
    expect(dailyTokens).toBe(s.kpis.totalTokens);
  });

  it('a digest whose archived span predates the window is excluded (≥90d idle vs 30d window)', () => {
    const { runs, insights, db } = setupWithDb();
    const now = Date.now();
    seedRun(runs, { kind: 'chat', inputTokens: 5, startedAt: now });
    const conv = runs.ensureAutomationConversation('auto.old/job', 'auto.old');
    insertDigest(db, {
      conversationId: conv,
      kind: 'automation',
      automationRef: 'auto.old/job',
      lastEndedAt: now - 120 * 86_400_000, // 120 days ago
      runCount: 9,
      inputTokens: 9999,
    });
    const s = insights.summary({ windowDays: 30 });
    expect(s.kpis.generations).toBe(1);
    expect(s.kpis.totalTokens).toBe(5);
  });

  it('reproduces pre-archive rollups after a simulated prune (digest parity)', () => {
    const { runs, insights, db } = setupWithDb();
    const now = Date.now();
    // Seed three live automation runs on one ref, plus a live chat run.
    for (const [i, tok] of [300, 700, 200].entries())
      seedRun(runs, {
        kind: 'automation',
        automationRef: 'auto.parity/job',
        automationName: 'Parity',
        model: 'm-a',
        inputTokens: tok,
        costUsd: 0.01 * (i + 1),
        startedAt: now,
      });
    seedRun(runs, { kind: 'chat', model: 'm-b', inputTokens: 50, costUsd: 0.001, startedAt: now });

    const before = insights.summary({ windowDays: 365 });

    // Build the digest from the live run_summary rows of the automation conv,
    // then prune those raw turns (conversation row STAYS — only turns/items go).
    const convId = 'auto.parity/job';
    const rollup = db
      .prepare(
        `SELECT COUNT(*) AS runs,
                SUM(COALESCE(total_input_tokens,0)+COALESCE(total_output_tokens,0)
                   +COALESCE(total_cache_read_tokens,0)+COALESCE(total_cache_write_tokens,0)) AS tokens,
                SUM(COALESCE(total_cost_usd,0)) AS cost,
                MAX(ended_at) AS last_ended
         FROM run_summary WHERE automation_ref = ?`,
      )
      .get(convId) as { runs: number; tokens: number; cost: number; last_ended: number };
    insertDigest(db, {
      conversationId: convId,
      kind: 'automation',
      automationRef: convId,
      automationName: 'Parity',
      lastEndedAt: rollup.last_ended,
      runCount: rollup.runs,
      inputTokens: rollup.tokens,
      costUsd: rollup.cost,
      models: [{ model: 'm-a', runs: rollup.runs, tokens: rollup.tokens, cost: rollup.cost }],
    });
    db.prepare(`DELETE FROM turns WHERE conversation_id = ?`).run(convId);

    const after = insights.summary({ windowDays: 365 });
    // The dashboard numbers are identical before archive and after prune.
    expect(after.kpis.generations).toBe(before.kpis.generations);
    expect(after.kpis.totalTokens).toBe(before.kpis.totalTokens);
    expect(after.kpis.totalCostUsd).toBe(before.kpis.totalCostUsd);
    const beforeAuto = before.byAutomation.find((r) => r.key === convId);
    const afterAuto = after.byAutomation.find((r) => r.key === convId);
    expect(afterAuto?.runs).toBe(beforeAuto?.runs);
    expect(afterAuto?.tokens).toBe(beforeAuto?.tokens);
    const beforeModelA = before.byModel.find((m) => m.model === 'm-a');
    const afterModelA = after.byModel.find((m) => m.model === 'm-a');
    expect(afterModelA?.runs).toBe(beforeModelA?.runs);
    expect(afterModelA?.tokens).toBe(beforeModelA?.tokens);
  });
});
