/*
 * InsightsStore — read-only analytics over the central `run_summary`
 * ledger (issue #98, decision 4).
 *
 * The Insights screen reads entirely from the push-based
 * `centraid-analytics.sqlite` — one summary row per run, every kind. No
 * cross-file scan, no `run_nodes` descent: the by-model breakdown keys
 * off each run's dominant model. Every figure is scoped to a trailing
 * `windowDays` window (default 30).
 *
 * The `total_*` rollup is exclusive of child `invoke` sub-runs, so a
 * plain SUM over every summary in the window is the true grand total
 * with no double-count. A run that crashed before `finishRun` has NULL
 * rollups — it still counts as a "generation" but contributes 0
 * tokens/cost (accepted for v0).
 *
 * Constructed with the analytics `DatabaseProvider`
 * (`makeAnalyticsDbProvider`).
 */

import { type DatabaseSync, type StatementSync } from 'node:sqlite';
import type { DatabaseProvider } from './gateway-db.js';

/** Placeholder per-user monthly token allowance — no billing model exists
 *  yet (issue #90, open question 5). */
export const INSIGHTS_QUOTA_TOKENS = 8_000_000;

const DEFAULT_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface InsightsKpis {
  /** input + output + cache read + cache write, summed over the window. */
  totalTokens: number;
  totalCostUsd: number;
  /** Window run-rate projected to a 30-day month. */
  forecastCostUsd: number;
  /** Count of runs in the window. */
  generations: number;
  /** Count of runs whose `retry_of` is set. */
  retries: number;
  /** Distinct apps touched by any run node in the window. */
  appsTouched: number;
  /** Placeholder monthly token allowance. */
  quotaTokens: number;
}

export interface InsightsDailyPoint {
  /** `YYYY-MM-DD` (UTC). */
  date: string;
  tokens: number;
  costUsd: number;
  runs: number;
}

export interface InsightsAutomationRow {
  /** `<appId>/<id>` automation handle, or the bucket key `chat` / `build`. */
  key: string;
  label: string;
  kind: string;
  runs: number;
  tokens: number;
  costUsd: number;
}

export interface InsightsModelRow {
  model: string;
  runs: number;
  tokens: number;
  costUsd: number;
}

export interface InsightsActivityRow {
  runId: string;
  kind: string;
  label: string;
  ok: boolean;
  startedAt: number;
  tokens: number;
  costUsd: number;
}

export interface InsightsSummary {
  windowDays: number;
  generatedAt: number;
  kpis: InsightsKpis;
  daily: InsightsDailyPoint[];
  byAutomation: InsightsAutomationRow[];
  byModel: InsightsModelRow[];
  recent: InsightsActivityRow[];
}

// Token total summed inline in SQL — NULL rollup columns coalesce to 0.
const TOKEN_SUM = `(COALESCE(total_input_tokens,0)+COALESCE(total_output_tokens,0)
  +COALESCE(total_cache_read_tokens,0)+COALESCE(total_cache_write_tokens,0))`;

interface PreparedStatements {
  kpis: StatementSync;
  appsTouched: StatementSync;
  daily: StatementSync;
  byAutomation: StatementSync;
  byModel: StatementSync;
  recent: StatementSync;
}

export class InsightsStore {
  private readonly provider: DatabaseProvider;
  private db: DatabaseSync | undefined;
  private stmts: PreparedStatements | undefined;

  constructor(provider: DatabaseProvider) {
    this.provider = provider;
  }

  private ensureReady(): PreparedStatements {
    if (this.stmts) return this.stmts;
    const db = this.provider();
    this.stmts = {
      kpis: db.prepare(`
        SELECT
          COUNT(*) AS generations,
          SUM(CASE WHEN retry_of IS NOT NULL THEN 1 ELSE 0 END) AS retries,
          SUM(${TOKEN_SUM}) AS tokens,
          SUM(COALESCE(total_cost_usd, 0)) AS cost
        FROM run_summary
        WHERE started_at >= ?
      `),
      appsTouched: db.prepare(`
        SELECT COUNT(DISTINCT app_id) AS apps
        FROM run_summary
        WHERE started_at >= ? AND app_id IS NOT NULL
      `),
      daily: db.prepare(`
        SELECT
          date(started_at / 1000, 'unixepoch') AS day,
          SUM(${TOKEN_SUM}) AS tokens,
          SUM(COALESCE(total_cost_usd, 0)) AS cost,
          COUNT(*) AS runs
        FROM run_summary
        WHERE started_at >= ?
        GROUP BY day ORDER BY day ASC
      `),
      // Automations live on disk (issue #98) — there is no table to
      // join for a display name. `name` is NULL here; the desktop
      // resolves it from the project manifest.
      byAutomation: db.prepare(`
        SELECT
          kind AS kind,
          automation_ref AS automation_ref,
          NULL AS name,
          COUNT(*) AS runs,
          SUM(${TOKEN_SUM}) AS tokens,
          SUM(COALESCE(total_cost_usd, 0)) AS cost
        FROM run_summary
        WHERE started_at >= ?
        GROUP BY kind, automation_ref
        ORDER BY tokens DESC
      `),
      byModel: db.prepare(`
        SELECT
          model AS model,
          COUNT(*) AS runs,
          SUM(${TOKEN_SUM}) AS tokens,
          SUM(COALESCE(total_cost_usd, 0)) AS cost
        FROM run_summary
        WHERE started_at >= ? AND model IS NOT NULL
        GROUP BY model ORDER BY tokens DESC
      `),
      recent: db.prepare(`
        SELECT
          run_id AS id, kind AS kind, ok AS ok, started_at AS started_at,
          summary AS summary, note AS note, NULL AS name,
          ${TOKEN_SUM} AS tokens, COALESCE(total_cost_usd, 0) AS cost
        FROM run_summary
        WHERE started_at >= ?
        ORDER BY started_at DESC LIMIT ?
      `),
    };
    this.db = db;
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
      tokens: number | null;
      cost: number | null;
    };
    const appsRow = stmts.appsTouched.get(since) as { apps: number | null };
    const totalCostUsd = round(k.cost ?? 0);
    const kpis: InsightsKpis = {
      totalTokens: k.tokens ?? 0,
      totalCostUsd,
      forecastCostUsd: round((totalCostUsd / windowDays) * 30),
      generations: k.generations ?? 0,
      retries: k.retries ?? 0,
      appsTouched: appsRow.apps ?? 0,
      quotaTokens: INSIGHTS_QUOTA_TOKENS,
    };

    const daily: InsightsDailyPoint[] = (
      stmts.daily.all(since) as Array<{
        day: string;
        tokens: number | null;
        cost: number | null;
        runs: number;
      }>
    ).map((d) => ({
      date: d.day,
      tokens: d.tokens ?? 0,
      costUsd: round(d.cost ?? 0),
      runs: d.runs,
    }));

    const byAutomation: InsightsAutomationRow[] = (
      stmts.byAutomation.all(since) as Array<{
        kind: string;
        automation_ref: string | null;
        name: string | null;
        runs: number;
        tokens: number | null;
        cost: number | null;
      }>
    ).map((r) => ({
      key: r.automation_ref ?? r.kind,
      label: r.name ?? bucketLabel(r.kind),
      kind: r.kind,
      runs: r.runs,
      tokens: r.tokens ?? 0,
      costUsd: round(r.cost ?? 0),
    }));

    const byModel: InsightsModelRow[] = (
      stmts.byModel.all(since) as Array<{
        model: string;
        runs: number;
        tokens: number | null;
        cost: number | null;
      }>
    ).map((r) => ({
      model: r.model,
      runs: r.runs,
      tokens: r.tokens ?? 0,
      costUsd: round(r.cost ?? 0),
    }));

    const recent: InsightsActivityRow[] = (
      stmts.recent.all(since, recentLimit) as Array<{
        id: string;
        kind: string;
        ok: number;
        started_at: number;
        summary: string | null;
        note: string | null;
        name: string | null;
        tokens: number | null;
        cost: number | null;
      }>
    ).map((r) => ({
      runId: r.id,
      kind: r.kind,
      label: r.summary ?? r.note ?? r.name ?? bucketLabel(r.kind),
      ok: r.ok !== 0,
      startedAt: r.started_at,
      tokens: r.tokens ?? 0,
      costUsd: round(r.cost ?? 0),
    }));

    return { windowDays, generatedAt: now, kpis, daily, byAutomation, byModel, recent };
  }
}

function bucketLabel(kind: string): string {
  if (kind === 'chat') return 'Chat';
  if (kind === 'build') return 'Builds';
  if (kind === 'automation') return 'Automation';
  return kind;
}

/** Round a USD figure to 4 decimal places to keep float drift out of sums. */
function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
