/*
 * InsightsStore — read-only analytics over the vault's `run_summary` view
 * (issue #98, decision 4) UNIONED with the `conversation_digest` rollup of
 * archived-and-pruned runs (issue #438, decision 5).
 *
 * The Insights screen reads from two sources in the vault's `journal.db`:
 *   · LIVE runs — `run_summary`, a VIEW deriving one row per finished run,
 *     every kind, from the ledger tables in the same file. No cross-file scan,
 *     no items descent: the by-model breakdown keys off each run's dominant
 *     model, which the view computes.
 *   · ARCHIVED runs — `conversation_digest`, one materialized row per
 *     conversation covering the portion whose raw turns/items were archived to
 *     the CAS and pruned (#438). Without it, pruning would starve Insights.
 *     Each aggregate below unions live `run_summary` numbers with the digest
 *     rollups so the figures are identical before archive and after prune.
 *
 * Every figure is scoped to a trailing `windowDays` window (default 30).
 * A digest joins the window when its ARCHIVED SPAN intersects it — i.e.
 * `last_ended_at >= since` (digests carry span endpoints, not per-run start
 * times). Because runs archive only after the ≥90d idle horizon, digests rarely
 * intersect the default 30d window at all; when a longer window reaches them,
 * their rollups attribute coarsely (the day-grain series collapses a digest to
 * its last archived day — acceptable beyond the horizon, documented per query).
 * `recent` is row-grain and reads LIVE rows only: an archived run is ≥90d idle
 * by definition, past the tail of a recent-activity feed.
 *
 * The `total_*` rollup is exclusive of child `invoke` sub-runs, so a
 * plain SUM over every summary in the window is the true grand total
 * with no double-count. A run that crashed before `finishTurn` never
 * enters the view — it reappears in the ledger tables only (accepted
 * for v0: Insights counts completed runs).
 *
 * Constructed with the vault's journal `DatabaseProvider`
 * (`makeJournalDbProvider`, or the gateway's active-vault resolver).
 */

import { type DatabaseSync, type StatementSync } from 'node:sqlite';
import type { DatabaseProvider } from '../stores/gateway-db.js';

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
  /**
   * The automation's last-known display name, recorded on its runs
   * (`run_summary.automation_name`). Set only for `kind: 'automation'`
   * rows that have at least one run recorded since the field existed —
   * the desktop prefers the live manifest name and falls back to this,
   * then to `key` (the raw ref), for a deleted automation.
   */
  automationName?: string;
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
  /** `<appId>/<id>` handle — set for automation runs so the desktop can
   *  resolve the display name from the manifest (same deal as `name`). */
  automationRef?: string;
  /** The automation's last-known display name — see `InsightsAutomationRow.automationName`. */
  automationName?: string;
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

// Token total summed inline in SQL — NULL rollup columns coalesce to 0. The
// column names are shared by `run_summary` and `conversation_digest`, so the
// same expression reads either source.
const TOKEN_SUM = `(COALESCE(total_input_tokens,0)+COALESCE(total_output_tokens,0)
  +COALESCE(total_cache_read_tokens,0)+COALESCE(total_cache_write_tokens,0))`;

interface PreparedStatements {
  // LIVE — over run_summary (unchanged from the pre-#438 shape; the digest
  // arms below add archived-and-pruned runs on top). appsTouched now returns
  // the distinct app_id ROWS instead of a count so the live+digest sets union.
  kpis: StatementSync;
  appsTouched: StatementSync;
  daily: StatementSync;
  byAutomation: StatementSync;
  byModel: StatementSync;
  recent: StatementSync;
  // ARCHIVED — over conversation_digest, one arm per aggregate (#438). Each
  // takes the window's `since` and admits a digest whose archived span reaches
  // into it (`last_ended_at >= since`). With zero digest rows every arm is
  // empty, so the union is byte-identical to the live-only result.
  kpisDigest: StatementSync;
  appsTouchedDigest: StatementSync;
  dailyDigest: StatementSync;
  byAutomationDigest: StatementSync;
  byModelDigest: StatementSync;
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
    // wires "the ACTIVE vault's journal.db") — re-prepare on change.
    const db = this.provider();
    if (this.stmts && this.db === db) return this.stmts;
    this.db = db;
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
        SELECT DISTINCT app_id AS app_id
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
      // Automations live on disk (issue #98) — there is no table to join
      // for the CURRENT display name, so `name` here is the last-known
      // name recorded on any run in the window (`run_summary.automation_name`,
      // NULL for runs recorded before that field existed). The desktop
      // prefers the live manifest name and falls back to this for a
      // deleted automation, ahead of the raw ref.
      byAutomation: db.prepare(`
        SELECT
          kind AS kind,
          automation_ref AS automation_ref,
          MAX(automation_name) AS name,
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
      // recent is row-grain and LIVE-only by design: an archived run is ≥90d
      // idle, past the tail of a recent-activity feed — no digest arm.
      recent: db.prepare(`
        SELECT
          run_id AS id, kind AS kind, ok AS ok, started_at AS started_at,
          summary AS summary, note AS note, automation_name AS name,
          automation_ref AS automation_ref,
          ${TOKEN_SUM} AS tokens, COALESCE(total_cost_usd, 0) AS cost
        FROM run_summary
        WHERE started_at >= ?
        ORDER BY started_at DESC LIMIT ?
      `),
      // Digest arms (#438). `last_ended_at >= ?` = the archived span reaches
      // into the window. COALESCE keeps a legacy NULL last_ended_at out.
      kpisDigest: db.prepare(`
        SELECT
          COALESCE(SUM(run_count), 0) AS generations,
          COALESCE(SUM(retry_count), 0) AS retries,
          COALESCE(SUM(${TOKEN_SUM}), 0) AS tokens,
          COALESCE(SUM(total_cost_usd), 0) AS cost
        FROM conversation_digest
        WHERE last_ended_at IS NOT NULL AND last_ended_at >= ?
      `),
      appsTouchedDigest: db.prepare(`
        SELECT DISTINCT app_id AS app_id
        FROM conversation_digest
        WHERE last_ended_at IS NOT NULL AND last_ended_at >= ? AND app_id IS NOT NULL
      `),
      // One row per digest, attributed to its LAST archived day. Beyond the ≥90d
      // horizon a digest's runs collapse to that single coarse point — the
      // day-grain series cannot recover per-run start days once rows are pruned.
      // The window filter matches kpisDigest, so SUM(daily) == kpis totals.
      dailyDigest: db.prepare(`
        SELECT
          date(last_ended_at / 1000, 'unixepoch') AS day,
          ${TOKEN_SUM} AS tokens,
          COALESCE(total_cost_usd, 0) AS cost,
          run_count AS runs
        FROM conversation_digest
        WHERE last_ended_at IS NOT NULL AND last_ended_at >= ?
      `),
      byAutomationDigest: db.prepare(`
        SELECT
          kind AS kind,
          automation_ref AS automation_ref,
          automation_name AS name,
          run_count AS runs,
          ${TOKEN_SUM} AS tokens,
          COALESCE(total_cost_usd, 0) AS cost
        FROM conversation_digest
        WHERE last_ended_at IS NOT NULL AND last_ended_at >= ?
      `),
      // models_json is the per-model rollup [{model,runs,tokens,cost}] the
      // digest writer records with the SAME dominant-model-per-run pick as
      // run_summary.model, so `runs` sums consistently across the union.
      byModelDigest: db.prepare(`
        SELECT
          json_extract(m.value, '$.model') AS model,
          COALESCE(json_extract(m.value, '$.runs'), 0) AS runs,
          COALESCE(json_extract(m.value, '$.tokens'), 0) AS tokens,
          COALESCE(json_extract(m.value, '$.cost'), 0) AS cost
        FROM conversation_digest d, json_each(d.models_json) m
        WHERE d.last_ended_at IS NOT NULL AND d.last_ended_at >= ?
          AND json_extract(m.value, '$.model') IS NOT NULL
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

    // KPIs: live + archived-digest totals (#438). A digest joins only when its
    // archived span reaches into the window, so a run counts identically before
    // archive (live row) and after prune (digest rollup).
    const k = stmts.kpis.get(since) as {
      generations: number | null;
      retries: number | null;
      tokens: number | null;
      cost: number | null;
    };
    const kd = stmts.kpisDigest.get(since) as {
      generations: number | null;
      retries: number | null;
      tokens: number | null;
      cost: number | null;
    };
    // appsTouched: union the distinct app_id sets, then count.
    const apps = new Set<string>();
    for (const r of stmts.appsTouched.all(since) as Array<{ app_id: string | null }>)
      if (r.app_id !== null) apps.add(r.app_id);
    for (const r of stmts.appsTouchedDigest.all(since) as Array<{ app_id: string | null }>)
      if (r.app_id !== null) apps.add(r.app_id);
    const totalCostUsd = round((k.cost ?? 0) + (kd.cost ?? 0));
    const kpis: InsightsKpis = {
      totalTokens: (k.tokens ?? 0) + (kd.tokens ?? 0),
      totalCostUsd,
      forecastCostUsd: round((totalCostUsd / windowDays) * 30),
      generations: (k.generations ?? 0) + (kd.generations ?? 0),
      retries: (k.retries ?? 0) + (kd.retries ?? 0),
      appsTouched: apps.size,
      quotaTokens: INSIGHTS_QUOTA_TOKENS,
    };

    // Daily: live per-day buckets, then fold each digest into its last-archived
    // day (coarse beyond the horizon). Same window filter as kpis ⇒ totals tie.
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
    const daily: InsightsDailyPoint[] = [...dayBuckets.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([date, b]) => ({ date, tokens: b.tokens, costUsd: round(b.cost), runs: b.runs }));

    // byAutomation: union live + digest grouped by (kind, automation_ref).
    interface AutoAcc {
      kind: string;
      automationRef: string | null;
      name: string | null;
      runs: number;
      tokens: number;
      cost: number;
    }
    const autoGroups = new Map<string, AutoAcc>();
    const addAuto = (
      kind: string,
      automationRef: string | null,
      name: string | null,
      runs: number,
      tokens: number,
      cost: number,
    ): void => {
      const key = `${kind} ${automationRef ?? ''}`;
      const g = autoGroups.get(key) ?? {
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
      // Mirror SQL MAX(automation_name): keep the lexicographically greatest.
      if (name !== null && (g.name === null || name > g.name)) g.name = name;
      autoGroups.set(key, g);
    };
    for (const r of stmts.byAutomation.all(since) as Array<{
      kind: string;
      automation_ref: string | null;
      name: string | null;
      runs: number;
      tokens: number | null;
      cost: number | null;
    }>)
      addAuto(r.kind, r.automation_ref, r.name, r.runs, r.tokens ?? 0, r.cost ?? 0);
    for (const r of stmts.byAutomationDigest.all(since) as Array<{
      kind: string;
      automation_ref: string | null;
      name: string | null;
      runs: number;
      tokens: number | null;
      cost: number | null;
    }>)
      addAuto(r.kind, r.automation_ref, r.name, r.runs, r.tokens ?? 0, r.cost ?? 0);
    const byAutomation: InsightsAutomationRow[] = [...autoGroups.values()]
      .sort((a, b) => b.tokens - a.tokens)
      .map((g) => ({
        key: g.automationRef ?? g.kind,
        label: g.name ?? bucketLabel(g.kind),
        kind: g.kind,
        runs: g.runs,
        tokens: g.tokens,
        costUsd: round(g.cost),
        ...(g.name !== null ? { automationName: g.name } : {}),
      }));

    // byModel: union live dominant-model rows + digest per-model rollups.
    const modelGroups = new Map<string, { runs: number; tokens: number; cost: number }>();
    const addModel = (model: string, runs: number, tokens: number, cost: number): void => {
      const g = modelGroups.get(model) ?? { runs: 0, tokens: 0, cost: 0 };
      g.runs += runs;
      g.tokens += tokens;
      g.cost += cost;
      modelGroups.set(model, g);
    };
    for (const r of stmts.byModel.all(since) as Array<{
      model: string;
      runs: number;
      tokens: number | null;
      cost: number | null;
    }>)
      addModel(r.model, r.runs, r.tokens ?? 0, r.cost ?? 0);
    for (const r of stmts.byModelDigest.all(since) as Array<{
      model: string;
      runs: number;
      tokens: number | null;
      cost: number | null;
    }>)
      addModel(r.model, r.runs, r.tokens ?? 0, r.cost ?? 0);
    const byModel: InsightsModelRow[] = [...modelGroups.entries()]
      .sort(([, a], [, b]) => b.tokens - a.tokens)
      .map(([model, g]) => ({ model, runs: g.runs, tokens: g.tokens, costUsd: round(g.cost) }));

    const recent: InsightsActivityRow[] = (
      stmts.recent.all(since, recentLimit) as Array<{
        id: string;
        kind: string;
        ok: number;
        started_at: number;
        summary: string | null;
        note: string | null;
        name: string | null;
        automation_ref: string | null;
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
