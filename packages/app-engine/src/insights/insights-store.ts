/*
 * InsightsStore — transparency + control aggregates over the vault ledger
 * (issue #514 rewrite; prior #98 / #438).
 *
 * Product promise: everything Centraid saw agents use — priced when we can,
 * marked when we can't — so the owner can control apps and automations.
 *
 * Sources in the vault's `journal.db`:
 *   · LIVE — `run_summary` (VIEW: finished turns ⋈ conversations)
 *   · COST PROVENANCE — `items.cost_source` ('agent' | 'estimated')
 *   · ARCHIVED — `conversation_digest` rollups after prune (#438)
 *
 * Digests carry totals only (no agent/estimated split); provenance KPIs are
 * live-arm only. `recent` is live-only (archived runs are ≥90d idle).
 */

import { type DatabaseSync } from 'node:sqlite';
import type { DatabaseProvider } from '../stores/gateway-db.js';
import { prepareInsightsStatements, type InsightsPreparedStatements } from './insights-sql.js';
import type {
  InsightsActivityRow,
  InsightsAttention,
  InsightsDailyPoint,
  InsightsKpis,
  InsightsModelRow,
  InsightsPeakDay,
  InsightsRunnerRow,
  InsightsSourceRow,
  InsightsSummary,
} from './insights-types.js';

export type {
  InsightsActivityRow,
  InsightsAttention,
  InsightsDailyPoint,
  InsightsKpis,
  InsightsModelRow,
  InsightsPeakDay,
  InsightsRunnerRow,
  InsightsSourceRow,
  InsightsSummary,
} from './insights-types.js';

const DEFAULT_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Share of spend that triggers the attention callout. */
const ATTENTION_SHARE = 0.4;

export class InsightsStore {
  private readonly provider: DatabaseProvider;
  private db: DatabaseSync | undefined;
  private stmts: InsightsPreparedStatements | undefined;

  constructor(provider: DatabaseProvider) {
    this.provider = provider;
  }

  private ensureReady(): InsightsPreparedStatements {
    const db = this.provider();
    if (this.stmts && this.db === db) return this.stmts;
    this.db = db;
    this.stmts = prepareInsightsStatements(db);
    return this.stmts;
  }

  /** Compute the full Insights payload for a trailing window. */
  summary(opts: { windowDays?: number; recentLimit?: number } = {}): InsightsSummary {
    const stmts = this.ensureReady();
    const windowDays = Math.max(1, opts.windowDays ?? DEFAULT_WINDOW_DAYS);
    const recentLimit = Math.max(1, opts.recentLimit ?? 12);
    const now = Date.now();
    const since = now - windowDays * DAY_MS;

    const k = stmts.kpis.get(since) as {
      generations: number | null;
      retries: number | null;
      failed: number | null;
      failed_cost: number | null;
      tokens: number | null;
      cost: number | null;
      unpriced: number | null;
      unreported: number | null;
    };
    const split = stmts.costSplit.get(since) as {
      agent_cost: number | null;
      estimated_cost: number | null;
    };
    const kd = stmts.kpisDigest.get(since) as {
      generations: number | null;
      retries: number | null;
      tokens: number | null;
      cost: number | null;
    };

    const apps = new Set<string>();
    for (const r of stmts.appsTouched.all(since) as Array<{ app_id: string | null }>)
      if (r.app_id !== null) apps.add(r.app_id);
    for (const r of stmts.appsTouchedDigest.all(since) as Array<{ app_id: string | null }>)
      if (r.app_id !== null) apps.add(r.app_id);

    const agentReportedCostUsd = round(split.agent_cost ?? 0);
    const estimatedCostUsd = round(split.estimated_cost ?? 0);
    const totalCostUsd = round((k.cost ?? 0) + (kd.cost ?? 0));

    const kpis: InsightsKpis = {
      totalTokens: (k.tokens ?? 0) + (kd.tokens ?? 0),
      totalCostUsd,
      agentReportedCostUsd,
      estimatedCostUsd,
      forecastCostUsd: round((totalCostUsd / windowDays) * 30),
      generations: (k.generations ?? 0) + (kd.generations ?? 0),
      retries: (k.retries ?? 0) + (kd.retries ?? 0),
      failedRuns: k.failed ?? 0,
      failedCostUsd: round(k.failed_cost ?? 0),
      appsTouched: apps.size,
      unpricedRuns: k.unpriced ?? 0,
      unreportedRuns: k.unreported ?? 0,
    };

    const daily = foldDaily(stmts, since);
    const bySource = foldBySource(stmts, since);
    const byRunner: InsightsRunnerRow[] = (
      stmts.byRunner.all(since) as Array<{
        provider: string;
        runs: number;
        tokens: number | null;
        cost: number | null;
      }>
    ).map((r) => ({
      provider: r.provider,
      runs: r.runs,
      tokens: r.tokens ?? 0,
      costUsd: round(r.cost ?? 0),
    }));
    const byModel = foldByModel(stmts, since);
    const recent = foldRecent(stmts, since, recentLimit);
    const peakDay = buildPeakDay(stmts, since, daily);
    const attention = buildAttention(bySource, totalCostUsd);

    return {
      windowDays,
      generatedAt: now,
      kpis,
      daily,
      bySource,
      byRunner,
      byModel,
      recent,
      ...(peakDay ? { peakDay } : {}),
      ...(attention ? { attention } : {}),
    };
  }
}

function foldDaily(stmts: InsightsPreparedStatements, since: number): InsightsDailyPoint[] {
  const dayBuckets = new Map<string, { tokens: number; cost: number; runs: number }>();
  const addDay = (day: string, tokens: number, cost: number, runs: number): void => {
    const b = dayBuckets.get(day) ?? { tokens: 0, cost: 0, runs: 0 };
    b.tokens += tokens;
    b.cost += cost;
    b.runs += runs;
    dayBuckets.set(day, b);
  };
  for (const d of stmts.daily.all(since) as Array<{
    day: string;
    tokens: number | null;
    cost: number | null;
    runs: number;
  }>)
    addDay(d.day, d.tokens ?? 0, d.cost ?? 0, d.runs);
  for (const d of stmts.dailyDigest.all(since) as Array<{
    day: string;
    tokens: number | null;
    cost: number | null;
    runs: number;
  }>)
    addDay(d.day, d.tokens ?? 0, d.cost ?? 0, d.runs);
  return [...dayBuckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, b]) => ({ date, tokens: b.tokens, costUsd: round(b.cost), runs: b.runs }));
}

function foldBySource(stmts: InsightsPreparedStatements, since: number): InsightsSourceRow[] {
  interface Acc {
    kind: string;
    automationRef: string | null;
    name: string | null;
    runs: number;
    tokens: number;
    cost: number;
  }
  const groups = new Map<string, Acc>();
  const add = (
    kind: string,
    automationRef: string | null,
    name: string | null,
    runs: number,
    tokens: number,
    cost: number,
  ): void => {
    const key = `${kind}\0${automationRef ?? ''}`;
    const g = groups.get(key) ?? {
      kind,
      automationRef,
      name: null,
      runs: 0,
      tokens: 0,
      cost: 0,
    };
    g.runs += runs;
    g.tokens += tokens;
    g.cost += cost;
    if (name !== null && (g.name === null || name > g.name)) g.name = name;
    groups.set(key, g);
  };
  for (const r of stmts.bySource.all(since) as Array<{
    kind: string;
    automation_ref: string | null;
    name: string | null;
    runs: number;
    tokens: number | null;
    cost: number | null;
  }>)
    add(r.kind, r.automation_ref, r.name, r.runs, r.tokens ?? 0, r.cost ?? 0);
  for (const r of stmts.bySourceDigest.all(since) as Array<{
    kind: string;
    automation_ref: string | null;
    name: string | null;
    runs: number;
    tokens: number | null;
    cost: number | null;
  }>)
    add(r.kind, r.automation_ref, r.name, r.runs, r.tokens ?? 0, r.cost ?? 0);
  return [...groups.values()]
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens)
    .map((g) => ({
      key: g.automationRef ?? g.kind,
      label: g.name ?? bucketLabel(g.kind),
      kind: g.kind,
      runs: g.runs,
      tokens: g.tokens,
      costUsd: round(g.cost),
      ...(g.name !== null ? { automationName: g.name } : {}),
    }));
}

function foldByModel(stmts: InsightsPreparedStatements, since: number): InsightsModelRow[] {
  const groups = new Map<string, { runs: number; tokens: number; cost: number }>();
  const add = (model: string, runs: number, tokens: number, cost: number): void => {
    const g = groups.get(model) ?? { runs: 0, tokens: 0, cost: 0 };
    g.runs += runs;
    g.tokens += tokens;
    g.cost += cost;
    groups.set(model, g);
  };
  for (const r of stmts.byModel.all(since) as Array<{
    model: string;
    runs: number;
    tokens: number | null;
    cost: number | null;
  }>)
    add(r.model, r.runs, r.tokens ?? 0, r.cost ?? 0);
  for (const r of stmts.byModelDigest.all(since) as Array<{
    model: string;
    runs: number;
    tokens: number | null;
    cost: number | null;
  }>)
    add(r.model, r.runs, r.tokens ?? 0, r.cost ?? 0);
  return [...groups.entries()]
    .sort(([, a], [, b]) => b.cost - a.cost || b.tokens - a.tokens)
    .map(([model, g]) => ({ model, runs: g.runs, tokens: g.tokens, costUsd: round(g.cost) }));
}

function foldRecent(
  stmts: InsightsPreparedStatements,
  since: number,
  recentLimit: number,
): InsightsActivityRow[] {
  return (
    stmts.recent.all(since, recentLimit) as Array<{
      id: string;
      kind: string;
      ok: number;
      started_at: number;
      summary: string | null;
      note: string | null;
      name: string | null;
      automation_ref: string | null;
      model: string | null;
      provider: string | null;
      tokens: number | null;
      cost: number | null;
    }>
  ).map((r) => ({
    runId: r.id,
    kind: r.kind,
    label: r.summary ?? r.note ?? r.name ?? bucketLabel(r.kind),
    ...(r.automation_ref ? { automationRef: r.automation_ref } : {}),
    ...(r.name ? { automationName: r.name } : {}),
    ok: r.ok !== 0,
    startedAt: r.started_at,
    tokens: r.tokens ?? 0,
    costUsd: round(r.cost ?? 0),
    ...(r.provider ? { provider: r.provider } : {}),
    ...(r.model ? { model: r.model } : {}),
  }));
}

function buildPeakDay(
  stmts: InsightsPreparedStatements,
  since: number,
  daily: InsightsDailyPoint[],
): InsightsPeakDay | undefined {
  if (daily.length === 0) return undefined;
  let best = daily[0]!;
  for (const d of daily) {
    if (d.costUsd > best.costUsd || (d.costUsd === best.costUsd && d.tokens > best.tokens)) {
      best = d;
    }
  }
  const dayStart = Date.parse(`${best.date}T00:00:00.000Z`);
  const dayEnd = dayStart + DAY_MS;
  const topSources = (
    stmts.daySources.all(since, dayEnd, best.date) as Array<{
      kind: string;
      automation_ref: string | null;
      name: string | null;
      tokens: number | null;
      cost: number | null;
    }>
  ).map((r) => ({
    key: r.automation_ref ?? r.kind,
    label: r.name ?? bucketLabel(r.kind),
    kind: r.kind,
    tokens: r.tokens ?? 0,
    costUsd: round(r.cost ?? 0),
  }));
  return {
    date: best.date,
    tokens: best.tokens,
    costUsd: best.costUsd,
    topSources,
  };
}

function buildAttention(
  bySource: InsightsSourceRow[],
  totalCostUsd: number,
): InsightsAttention | undefined {
  if (bySource.length === 0 || totalCostUsd <= 0) return undefined;
  const top = bySource[0]!;
  const share = top.costUsd / totalCostUsd;
  if (share < ATTENTION_SHARE || top.costUsd <= 0) return undefined;
  return {
    kind: 'top_source',
    key: top.key,
    label: top.label,
    kindLabel: bucketLabel(top.kind),
    share: Math.round(share * 1000) / 1000,
    costUsd: top.costUsd,
  };
}

function bucketLabel(kind: string): string {
  if (kind === 'chat') return 'Chat';
  if (kind === 'build') return 'Builds';
  if (kind === 'automation') return 'Automation';
  return kind;
}

function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
