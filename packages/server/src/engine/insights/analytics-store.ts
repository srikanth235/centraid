/*
 * Live `run_summary` VIEW, row-grain only — do not fabricate from
 * `conversation_digest` (#438). Archived-and-pruned runs drop out.
 * `ensureReady` re-prepares on vault switch.
 */

import type { DatabaseSync, StatementSync } from "node:sqlite";

import type { RunSummary } from "../conversation/run-summary-sink.js";
import type { RunKind } from "../conversation/schema.js";
import type { DatabaseProvider } from "../stores/gateway-db.js";

export interface ListSummariesOptions {
  readonly automationRef?: string;
  /**
   * Applied in SQL before `LIMIT` so an excluded flood cannot crowd the
   * window (#731 M2). Ignored when `automationRef` is also set.
   */
  readonly excludeAutomationRefs?: readonly string[];
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
  effort: string | null;
  started_at: number;
  ended_at: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  total_cache_read_tokens: number | null;
  total_cache_write_tokens: number | null;
  hydration_tokens: number | null;
  total_cost_usd: number | null;
  step_count: number | null;
  tool_count: number | null;
}

function fromRaw(raw: RawSummary): RunSummary {
  return {
    runId: raw.run_id,
    kind: raw.kind as RunKind,
    ...(raw.automation_ref === null
      ? {}
      : { automationRef: raw.automation_ref }),
    ...(raw.automation_name === null
      ? {}
      : { automationName: raw.automation_name }),
    ...(raw.app_id === null ? {} : { appId: raw.app_id }),
    trigger: raw.trigger,
    ...(raw.trigger_origin === null
      ? {}
      : { triggerOrigin: raw.trigger_origin }),
    ok: raw.ok !== 0,
    pinned: raw.pinned !== 0,
    ...(raw.summary === null ? {} : { summary: raw.summary }),
    ...(raw.note === null ? {} : { note: raw.note }),
    ...(raw.error === null ? {} : { error: raw.error }),
    ...(raw.retry_of === null ? {} : { retryOf: raw.retry_of }),
    ...(raw.model === null ? {} : { model: raw.model }),
    ...(raw.effort === null ? {} : { effort: raw.effort }),
    startedAt: raw.started_at,
    ...(raw.ended_at === null ? {} : { endedAt: raw.ended_at }),
    ...(raw.total_input_tokens === null
      ? {}
      : { totalInputTokens: raw.total_input_tokens }),
    ...(raw.total_output_tokens === null
      ? {}
      : { totalOutputTokens: raw.total_output_tokens }),
    ...(raw.total_cache_read_tokens === null
      ? {}
      : { totalCacheReadTokens: raw.total_cache_read_tokens }),
    ...(raw.total_cache_write_tokens === null
      ? {}
      : { totalCacheWriteTokens: raw.total_cache_write_tokens }),
    ...(raw.hydration_tokens === null
      ? {}
      : { hydrationTokens: raw.hydration_tokens }),
    ...(raw.total_cost_usd === null
      ? {}
      : { totalCostUsd: raw.total_cost_usd }),
    ...(raw.step_count === null ? {} : { stepCount: raw.step_count }),
    ...(raw.tool_count === null ? {} : { toolCount: raw.tool_count }),
  };
}

interface PreparedStatements {
  getOne: StatementSync;
  listAll: StatementSync;
  listByRef: StatementSync;
}

export class AnalyticsStore {
  private readonly provider: DatabaseProvider;
  private db: DatabaseSync | undefined;
  private stmts: PreparedStatements | undefined;
  /** `NOT IN (...)` keyed by placeholder count; rebuilt on vault switch. */
  private excludeStmts = new Map<number, StatementSync>();

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
    this.excludeStmts = new Map();
    return this.stmts;
  }

  private listExcluding(refs: readonly string[]): StatementSync {
    const cached = this.excludeStmts.get(refs.length);
    if (cached) return cached;
    const placeholders = refs.map(() => "?").join(", ");
    const stmt = (this.db as DatabaseSync).prepare(`
      SELECT * FROM run_summary
      WHERE automation_ref IS NULL OR automation_ref NOT IN (${placeholders})
      ORDER BY started_at DESC LIMIT ?
    `);
    this.excludeStmts.set(refs.length, stmt);
    return stmt;
  }

  getSummary(runId: string): RunSummary | undefined {
    const { getOne } = this.ensureReady();
    const raw = getOne.get(runId) as RawSummary | undefined;
    return raw ? fromRaw(raw) : undefined;
  }

  listSummaries(opts: ListSummariesOptions = {}): RunSummary[] {
    const { listAll, listByRef } = this.ensureReady();
    const limit = opts.limit ?? 100;
    const rows =
      opts.automationRef === undefined
        ? opts.excludeAutomationRefs && opts.excludeAutomationRefs.length > 0
          ? (this.listExcluding(opts.excludeAutomationRefs).all(
              ...opts.excludeAutomationRefs,
              limit
            ) as unknown as RawSummary[])
          : (listAll.all(limit) as unknown as RawSummary[])
        : (listByRef.all(opts.automationRef, limit) as unknown as RawSummary[]);
    return rows.map(fromRaw);
  }
}
