/*
 * InsightsStore — read-only analytics over the vault's own `run_summary`
 * rollup (issue #98, decision 4; moved into the vault's `transcripts.db`
 * by #280, resolved per-request by #289).
 *
 * The Insights screen reads entirely from the push-based rollup — one
 * summary row per run, every kind, but only THIS vault's. No cross-file
 * scan, no item descent: the by-model breakdown keys off each run's
 * dominant model. Every figure is scoped to a trailing `windowDays`
 * window (default 30).
 *
 * The `total_*` rollup is exclusive of child `invoke` sub-runs, so a
 * plain SUM over every summary in the window is the true grand total
 * with no double-count. A run that crashed before finish has NULL
 * rollups — it still counts as a "generation" but contributes 0
 * tokens/cost (accepted for v0).
 *
 * Cost is NOT a billed figure — it is a local estimate frozen at write
 * time from the model-price table (`model-pricing.ts`). A run on a model
 * the table doesn't know keeps `total_cost_usd = NULL`: its tokens still
 * count, but its spend is silently zero. `unpricedRuns` / `unpricedTokens`
 * surface that blind spot so the UI can label spend as an estimate rather
 * than imply it is authoritative.
 *
 * Source labels (`byAutomation`) are resolved by an injected
 * `resolveSource` callback — automation/app display names live on disk,
 * not in a table to join, so the route that has the code registry passes
 * a resolver in.
 *
 * Constructed with the vault's transcripts `DatabaseProvider`.
 */

import { type DatabaseSync, type StatementSync } from 'node:sqlite';
import type { DatabaseProvider } from '../stores/gateway-db.js';

const DEFAULT_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface InsightsKpis {
  /** input + output + cache read + cache write, summed over the window. */
  totalTokens: number;
  /** Locally-estimated spend (see file header) — a lower bound: excludes
   *  the `unpricedRuns` whose model the price table doesn't know. */
  totalCostUsd: number;
  /** Window run-rate projected to a 30-day month. */
  forecastCostUsd: number;
  /** Count of runs in the window. */
  generations: number;
  /** Count of runs whose `retry_of` is set. */
  retries: number;
  /** Distinct apps with an AI run in the window (NOT app opens/usage). */
  appsTouched: number;
  /** Runs that consumed tokens but whose model was unpriced — their spend
   *  is missing from `totalCostUsd`, so it undercounts by this many runs. */
  unpricedRuns: number;
  /** Tokens attributable to unpriced runs — the size of the spend blind spot. */
  unpricedTokens: number;
  /** Cache-read tokens over the window (served from the prompt cache). A
   *  real signal, replacing the former placeholder monthly quota. */
  cacheReadTokens: number;
}

/** Identity of one "source" row before its display name is resolved. */
export interface InsightsSourceKey {
  kind: string;
  automationRef?: string;
  appId?: string;
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
  /** The vault this payload is scoped to (#289) — so the screen can name
   *  which vault it is showing after a switch. */
  vault?: { id: string; name: string };
  kpis: InsightsKpis;
  daily: InsightsDailyPoint[];
  byAutomation: InsightsAutomationRow[];
  byModel: InsightsModelRow[];
  recent: InsightsActivityRow[];
}

export interface InsightsSummaryOptions {
  windowDays?: number;
  recentLimit?: number;
  /** The scoped vault's identity, echoed into the payload. */
  vault?: { id: string; name: string };
  /** Resolve a source row's display name from the on-disk code registry.
   *  Returning `undefined` falls back to the built-in bucket/app-id label. */
  resolveSource?: (key: InsightsSourceKey) => string | undefined;
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
    // The provider may resolve a different handle across calls (the gateway
    // wires "the ACTIVE vault's transcripts.db") — re-prepare on change.
    const db = this.provider();
    if (this.stmts && this.db === db) return this.stmts;
    this.db = db;
    this.stmts = {
      kpis: db.prepare(`
        SELECT
          COUNT(*) AS generations,
          SUM(CASE WHEN retry_of IS NOT NULL THEN 1 ELSE 0 END) AS retries,
          SUM(${TOKEN_SUM}) AS tokens,
          SUM(COALESCE(total_cost_usd, 0)) AS cost,
          SUM(CASE WHEN total_cost_usd IS NULL AND ${TOKEN_SUM} > 0 THEN 1 ELSE 0 END)
            AS unpriced_runs,
          SUM(CASE WHEN total_cost_usd IS NULL THEN ${TOKEN_SUM} ELSE 0 END)
            AS unpriced_tokens,
          SUM(COALESCE(total_cache_read_tokens, 0)) AS cache_read
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
      // One row per (kind, automation, app) — so per-app copilot chats and
      // the vault assistant break out instead of collapsing into a single
      // "Chat" bucket. Display names live on disk (issue #98), not in a
      // table to join; the caller's `resolveSource` maps the raw ids to
      // names.
      byAutomation: db.prepare(`
        SELECT
          kind AS kind,
          automation_ref AS automation_ref,
          app_id AS app_id,
          COUNT(*) AS runs,
          SUM(${TOKEN_SUM}) AS tokens,
          SUM(COALESCE(total_cost_usd, 0)) AS cost
        FROM run_summary
        WHERE started_at >= ?
        GROUP BY kind, automation_ref, app_id
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
  summary(opts: InsightsSummaryOptions = {}): InsightsSummary {
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
      unpriced_runs: number | null;
      unpriced_tokens: number | null;
      cache_read: number | null;
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
      unpricedRuns: k.unpriced_runs ?? 0,
      unpricedTokens: k.unpriced_tokens ?? 0,
      cacheReadTokens: k.cache_read ?? 0,
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
        app_id: string | null;
        runs: number;
        tokens: number | null;
        cost: number | null;
      }>
    ).map((r) => {
      const automationRef = r.automation_ref ?? undefined;
      const appId = r.app_id ?? undefined;
      const resolved = opts.resolveSource?.({ kind: r.kind, automationRef, appId });
      return {
        // Key is stable per source: the automation ref, else kind+app, else kind.
        key: automationRef ?? (appId ? `${r.kind}:${appId}` : r.kind),
        label: resolved ?? appId ?? bucketLabel(r.kind),
        kind: r.kind,
        runs: r.runs,
        tokens: r.tokens ?? 0,
        costUsd: round(r.cost ?? 0),
      };
    });

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

    return {
      windowDays,
      generatedAt: now,
      ...(opts.vault ? { vault: opts.vault } : {}),
      kpis,
      daily,
      byAutomation,
      byModel,
      recent,
    };
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
