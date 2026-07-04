/*
 * AnalyticsStore — the per-vault run-summary rollup (issue #98, decision 4;
 * moved into the vault's own `transcripts.db` by #280).
 *
 * Push-based analytics: at run completion the runtime write-throughs one
 * summary row here. The `run_summary` table lives INSIDE the vault's
 * `transcripts.db` — every run, every kind, but only THIS vault's; a
 * central file would aggregate across vaults, which #280 forbids. This
 * store is the single source the Insights screen and the desktop
 * Executions feed read, so neither needs a cross-file scan.
 *
 * The write-through is best-effort: each caller wraps `recordRunSummary`
 * in try/catch so a rollup hiccup never fails the run. The ledger tables
 * in the same file stay authoritative for a rebuild.
 *
 * The provider usually resolves "the ACTIVE vault's transcripts.db", so
 * the handle can change across calls (a vault switch); `ensureReady`
 * re-prepares when it does.
 */

import { type DatabaseSync, type StatementSync } from 'node:sqlite';
import type { DatabaseProvider } from '../stores/gateway-db.js';
import type { RunKind } from '../conversation/schema.js';
import type { RunSummary, RunSummarySink } from '../conversation/run-summary-sink.js';

export interface ListSummariesOptions {
  /** Scope to one automation handle. */
  readonly automationRef?: string;
  readonly limit?: number;
}

interface RawSummary {
  run_id: string;
  kind: string;
  automation_ref: string | null;
  app_id: string | null;
  trigger: string;
  trigger_origin: string | null;
  ok: number;
  pinned: number;
  summary: string | null;
  note: string | null;
  error: string | null;
  retry_of: string | null;
  model: string | null;
  started_at: number;
  ended_at: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  total_cache_read_tokens: number | null;
  total_cache_write_tokens: number | null;
  total_cost_usd: number | null;
  step_count: number | null;
  tool_count: number | null;
}

function fromRaw(raw: RawSummary): RunSummary {
  return {
    runId: raw.run_id,
    kind: raw.kind as RunKind,
    ...(raw.automation_ref !== null ? { automationRef: raw.automation_ref } : {}),
    ...(raw.app_id !== null ? { appId: raw.app_id } : {}),
    trigger: raw.trigger,
    ...(raw.trigger_origin !== null ? { triggerOrigin: raw.trigger_origin } : {}),
    ok: raw.ok !== 0,
    pinned: raw.pinned !== 0,
    ...(raw.summary !== null ? { summary: raw.summary } : {}),
    ...(raw.note !== null ? { note: raw.note } : {}),
    ...(raw.error !== null ? { error: raw.error } : {}),
    ...(raw.retry_of !== null ? { retryOf: raw.retry_of } : {}),
    ...(raw.model !== null ? { model: raw.model } : {}),
    startedAt: raw.started_at,
    ...(raw.ended_at !== null ? { endedAt: raw.ended_at } : {}),
    ...(raw.total_input_tokens !== null ? { totalInputTokens: raw.total_input_tokens } : {}),
    ...(raw.total_output_tokens !== null ? { totalOutputTokens: raw.total_output_tokens } : {}),
    ...(raw.total_cache_read_tokens !== null
      ? { totalCacheReadTokens: raw.total_cache_read_tokens }
      : {}),
    ...(raw.total_cache_write_tokens !== null
      ? { totalCacheWriteTokens: raw.total_cache_write_tokens }
      : {}),
    ...(raw.total_cost_usd !== null ? { totalCostUsd: raw.total_cost_usd } : {}),
    ...(raw.step_count !== null ? { stepCount: raw.step_count } : {}),
    ...(raw.tool_count !== null ? { toolCount: raw.tool_count } : {}),
  };
}

interface PreparedStatements {
  upsert: StatementSync;
  getOne: StatementSync;
  listAll: StatementSync;
  listByRef: StatementSync;
  setPinned: StatementSync;
  deleteByRef: StatementSync;
}

/**
 * Store over a vault's `run_summary` table. Construct with the vault's
 * transcripts `DatabaseProvider` (`makeTranscriptsDbProvider`, or the
 * gateway's active-vault resolver).
 */
export class AnalyticsStore implements RunSummarySink {
  private readonly provider: DatabaseProvider;
  private db: DatabaseSync | undefined;
  private stmts: PreparedStatements | undefined;

  constructor(provider: DatabaseProvider) {
    this.provider = provider;
  }

  private ensureReady(): PreparedStatements {
    const db = this.provider();
    if (this.stmts && this.db === db) return this.stmts;
    this.stmts = {
      upsert: db.prepare(`
        INSERT INTO run_summary (
          run_id, kind, automation_ref, app_id, trigger, trigger_origin,
          ok, pinned, summary, note, error, retry_of, model, started_at, ended_at,
          total_input_tokens, total_output_tokens, total_cache_read_tokens,
          total_cache_write_tokens, total_cost_usd, step_count, tool_count
        ) VALUES (
          $runId, $kind, $automationRef, $appId, $trigger, $triggerOrigin,
          $ok, $pinned, $summary, $note, $error, $retryOf, $model, $startedAt, $endedAt,
          $totalInputTokens, $totalOutputTokens, $totalCacheReadTokens,
          $totalCacheWriteTokens, $totalCostUsd, $stepCount, $toolCount
        )
        ON CONFLICT(run_id) DO UPDATE SET
          kind = excluded.kind, automation_ref = excluded.automation_ref,
          app_id = excluded.app_id, trigger = excluded.trigger,
          trigger_origin = excluded.trigger_origin, ok = excluded.ok,
          pinned = excluded.pinned,
          summary = excluded.summary, note = excluded.note,
          error = excluded.error, retry_of = excluded.retry_of,
          model = excluded.model, started_at = excluded.started_at,
          ended_at = excluded.ended_at,
          total_input_tokens = excluded.total_input_tokens,
          total_output_tokens = excluded.total_output_tokens,
          total_cache_read_tokens = excluded.total_cache_read_tokens,
          total_cache_write_tokens = excluded.total_cache_write_tokens,
          total_cost_usd = excluded.total_cost_usd,
          step_count = excluded.step_count, tool_count = excluded.tool_count
      `),
      getOne: db.prepare(`SELECT * FROM run_summary WHERE run_id = ?`),
      listAll: db.prepare(`
        SELECT * FROM run_summary ORDER BY started_at DESC LIMIT ?
      `),
      listByRef: db.prepare(`
        SELECT * FROM run_summary WHERE automation_ref = ?
        ORDER BY started_at DESC LIMIT ?
      `),
      setPinned: db.prepare(`UPDATE run_summary SET pinned = ? WHERE run_id = ?`),
      deleteByRef: db.prepare(`DELETE FROM run_summary WHERE automation_ref = ?`),
    };
    this.db = db;
    return this.stmts;
  }

  /** Write (or overwrite) one run's summary. The run id is the key. */
  recordRunSummary(s: RunSummary): void {
    const { upsert } = this.ensureReady();
    upsert.run({
      runId: s.runId,
      kind: s.kind,
      automationRef: s.automationRef ?? null,
      appId: s.appId ?? null,
      trigger: s.trigger,
      triggerOrigin: s.triggerOrigin ?? null,
      ok: s.ok ? 1 : 0,
      pinned: s.pinned ? 1 : 0,
      summary: s.summary ?? null,
      note: s.note ?? null,
      error: s.error ?? null,
      retryOf: s.retryOf ?? null,
      model: s.model ?? null,
      startedAt: s.startedAt,
      endedAt: s.endedAt ?? null,
      totalInputTokens: s.totalInputTokens ?? null,
      totalOutputTokens: s.totalOutputTokens ?? null,
      totalCacheReadTokens: s.totalCacheReadTokens ?? null,
      totalCacheWriteTokens: s.totalCacheWriteTokens ?? null,
      totalCostUsd: s.totalCostUsd ?? null,
      stepCount: s.stepCount ?? null,
      toolCount: s.toolCount ?? null,
    });
  }

  /** One run's summary by id, or `undefined`. */
  getSummary(runId: string): RunSummary | undefined {
    const { getOne } = this.ensureReady();
    const raw = getOne.get(runId) as RawSummary | undefined;
    return raw ? fromRaw(raw) : undefined;
  }

  /** Run summaries newest-first; optionally scoped to one automation. */
  listSummaries(opts: ListSummariesOptions = {}): RunSummary[] {
    const { listAll, listByRef } = this.ensureReady();
    const limit = opts.limit ?? 100;
    const rows =
      opts.automationRef !== undefined
        ? (listByRef.all(opts.automationRef, limit) as unknown as RawSummary[])
        : (listAll.all(limit) as unknown as RawSummary[]);
    return rows.map(fromRaw);
  }

  /** Mirror a run's replay-fixture pin into the central summary. */
  setPinned(runId: string, pinned: boolean): void {
    this.ensureReady().setPinned.run(pinned ? 1 : 0, runId);
  }

  /** Drop every summary for one automation handle (the automation is gone). */
  deleteByRef(automationRef: string): void {
    this.ensureReady().deleteByRef.run(automationRef);
  }
}
