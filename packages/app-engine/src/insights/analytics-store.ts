/*
 * AnalyticsStore — a read-only lens over the per-vault `run_summary` VIEW
 * (issue #98, decision 4; moved into the vault's own `journal.db` by #280).
 *
 * `run_summary` used to be a denormalized table maintained by a best-effort
 * write-through at run completion — justified when the rollup lived in a
 * DIFFERENT file than the ledger. With both in the vault's `journal.db`
 * there is no file boundary to denormalize across, so the view (declared in
 * `CONVERSATION_LEDGER_DDL`) derives every row from `turns ⋈ conversations`
 * plus the dominant model from `items`: no write path, no drift, nothing to
 * rebuild. This store is the single source the Insights screen and the
 * desktop Executions feed read; it is per-vault, so a central store can
 * never aggregate across vaults (#280).
 *
 * The provider usually resolves "the ACTIVE vault's journal.db", so
 * the handle can change across calls (a vault switch); `ensureReady`
 * re-prepares when it does.
 *
 * ROW-GRAIN, LIVE-ONLY (issue #438). The Executions feed is a list of
 * individual runs, so it reads live `run_summary` rows exactly as before —
 * `conversation_digest` is an AGGREGATE rollup and cannot reconstitute
 * per-run rows, so no digest-derived rows are fabricated here. A run whose
 * raw turn was archived-and-pruned (≥90d idle) drops out of `listSummaries`
 * and `getSummary` returns `undefined` for it — acceptable in v1: the aggregate
 * dashboards (InsightsStore) stay whole via the digest union, and lazy
 * rehydration (wave 3) serves an archived run's transcript on demand.
 */

import { type DatabaseSync, type StatementSync } from 'node:sqlite';
import type { DatabaseProvider } from '../stores/gateway-db.js';
import type { RunKind } from '../conversation/schema.js';
import type { RunSummary } from '../conversation/run-summary-sink.js';

export interface ListSummariesOptions {
  /** Scope to one automation handle. */
  readonly automationRef?: string;
  readonly limit?: number;
}

interface RawSummary {
  run_id: string;
  kind: string;
  automation_ref: string | null;
  automation_name: string | null;
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
    ...(raw.automation_name !== null ? { automationName: raw.automation_name } : {}),
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
  getOne: StatementSync;
  listAll: StatementSync;
  listByRef: StatementSync;
}

/**
 * Read-only store over a vault's `run_summary` view. Construct with the
 * vault's journal `DatabaseProvider` (`makeJournalDbProvider`, or the
 * gateway's active-vault resolver). Mutations happen on the ledger tables
 * the view derives from (`ConversationStore.setTurnPinned`, conversation
 * deletes) and are visible here immediately.
 */
export class AnalyticsStore {
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
      getOne: db.prepare(`SELECT * FROM run_summary WHERE run_id = ?`),
      listAll: db.prepare(`
        SELECT * FROM run_summary ORDER BY started_at DESC LIMIT ?
      `),
      listByRef: db.prepare(`
        SELECT * FROM run_summary WHERE automation_ref = ?
        ORDER BY started_at DESC LIMIT ?
      `),
    };
    this.db = db;
    return this.stmts;
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
}
