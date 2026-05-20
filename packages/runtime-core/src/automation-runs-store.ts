/*
 * AutomationRunsStore — per-app run audit + ctx.state backing file.
 *
 * Lives in a separate SQLite file, `automations.sqlite`, next to the
 * app's `data.sqlite` and `logs.jsonl`. Owned exclusively by the
 * runtime; never reachable from the handler's `db` proxy or the
 * `centraid_sql_*` agent tools (see issue #80). Three tables:
 *
 *   runs       — one row per automation fire (scheduled/manual/replay/
 *                on_failure). Carries parent_run_id for sub-invocations,
 *                handler-return summary, validated output_json.
 *   run_nodes  — one row per ctx.tool / ctx.agent call inside a run.
 *                Promise.all-batched calls share a `batch_id`.
 *   state      — per-(automation_name, key) KV used by ctx.state.
 *
 * Schema, migrations, and row types live in `automation-runs-schema.ts`
 * so callers (e.g. desktop UI) can import the row shapes without
 * pulling in the SQLite-backed implementation.
 */

import { type DatabaseSync, type StatementSync } from 'node:sqlite';
import {
  openAutomationsDb,
  type AutomationRunRow,
  type AutomationRunNodeRow,
  type AutomationStateEntry,
  type AutomationTriggerKind,
  type AutomationRunNodeKind,
} from './automation-runs-schema.js';

interface RawRun {
  run_id: string;
  automation_name: string;
  trigger_kind: string;
  parent_run_id: string | null;
  input_json: string | null;
  started_at: number;
  ended_at: number | null;
  ok: number;
  error: string | null;
  summary: string | null;
  output_json: string | null;
  pinned: number;
}

interface RawNode {
  node_id: string;
  run_id: string;
  ordinal: number;
  batch_id: number | null;
  kind: string;
  name: string;
  args_json: string | null;
  output_json: string | null;
  ok: number;
  error: string | null;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  child_run_id: string | null;
}

interface RawState {
  automation_name: string;
  key: string;
  value_json: string;
  updated_at: number;
}

export interface InsertRunInput {
  readonly runId: string;
  readonly automationName: string;
  readonly triggerKind: AutomationTriggerKind;
  readonly parentRunId?: string;
  readonly inputJson?: string;
  readonly startedAt: number;
}

export interface FinishRunInput {
  readonly runId: string;
  readonly endedAt: number;
  readonly ok: boolean;
  readonly error?: string;
  readonly summary?: string;
  readonly outputJson?: string;
}

export interface InsertNodeInput {
  readonly nodeId: string;
  readonly runId: string;
  readonly ordinal: number;
  readonly batchId?: number;
  readonly kind: AutomationRunNodeKind;
  readonly name: string;
  readonly argsJson?: string;
  readonly outputJson?: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly durationMs: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly childRunId?: string;
}

export interface ListRunsOptions {
  readonly name?: string;
  readonly status?: 'ok' | 'error';
  readonly since?: number;
  readonly limit?: number;
}

interface PreparedStatements {
  insertRun: StatementSync;
  finishRun: StatementSync;
  getRun: StatementSync;
  listRunsByName: StatementSync;
  listRunsAll: StatementSync;
  lastRunByName: StatementSync;
  setPinned: StatementSync;
  pinnedRunByName: StatementSync;
  listChildRunsByParent: StatementSync;
  insertNode: StatementSync;
  listNodesByRun: StatementSync;
  upsertState: StatementSync;
  getState: StatementSync;
  deleteState: StatementSync;
  pruneByCount: StatementSync;
  pruneByDays: StatementSync;
  pruneErrorsOnly: StatementSync;
  countRunsByName: StatementSync;
}

function runFromRaw(raw: RawRun): AutomationRunRow {
  return {
    runId: raw.run_id,
    automationName: raw.automation_name,
    triggerKind: raw.trigger_kind as AutomationTriggerKind,
    ...(raw.parent_run_id !== null ? { parentRunId: raw.parent_run_id } : {}),
    ...(raw.input_json !== null ? { inputJson: raw.input_json } : {}),
    startedAt: raw.started_at,
    ...(raw.ended_at !== null ? { endedAt: raw.ended_at } : {}),
    ok: raw.ok !== 0,
    ...(raw.error !== null ? { error: raw.error } : {}),
    ...(raw.summary !== null ? { summary: raw.summary } : {}),
    ...(raw.output_json !== null ? { outputJson: raw.output_json } : {}),
    pinned: raw.pinned !== 0,
  };
}

function nodeFromRaw(raw: RawNode): AutomationRunNodeRow {
  return {
    nodeId: raw.node_id,
    runId: raw.run_id,
    ordinal: raw.ordinal,
    ...(raw.batch_id !== null ? { batchId: raw.batch_id } : {}),
    kind: raw.kind as AutomationRunNodeKind,
    name: raw.name,
    ...(raw.args_json !== null ? { argsJson: raw.args_json } : {}),
    ...(raw.output_json !== null ? { outputJson: raw.output_json } : {}),
    ok: raw.ok !== 0,
    ...(raw.error !== null ? { error: raw.error } : {}),
    startedAt: raw.started_at,
    ...(raw.ended_at !== null ? { endedAt: raw.ended_at } : {}),
    ...(raw.duration_ms !== null ? { durationMs: raw.duration_ms } : {}),
    ...(raw.input_tokens !== null ? { inputTokens: raw.input_tokens } : {}),
    ...(raw.output_tokens !== null ? { outputTokens: raw.output_tokens } : {}),
    ...(raw.child_run_id !== null ? { childRunId: raw.child_run_id } : {}),
  };
}

function stateFromRaw(raw: RawState): AutomationStateEntry {
  return {
    automationName: raw.automation_name,
    key: raw.key,
    valueJson: raw.value_json,
    updatedAt: raw.updated_at,
  };
}

function prepare(db: DatabaseSync): PreparedStatements {
  return {
    insertRun: db.prepare(`
      INSERT INTO runs (run_id, automation_name, trigger_kind, parent_run_id, input_json, started_at, ok)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `),
    finishRun: db.prepare(`
      UPDATE runs SET ended_at = ?, ok = ?, error = ?, summary = ?, output_json = ? WHERE run_id = ?
    `),
    getRun: db.prepare(`SELECT * FROM runs WHERE run_id = ?`),
    listRunsByName: db.prepare(`
      SELECT * FROM runs
      WHERE automation_name = ?
        AND (? IS NULL OR started_at >= ?)
        AND (? IS NULL OR ok = ?)
      ORDER BY started_at DESC LIMIT ?
    `),
    listRunsAll: db.prepare(`
      SELECT * FROM runs
      WHERE (? IS NULL OR started_at >= ?)
        AND (? IS NULL OR ok = ?)
      ORDER BY started_at DESC LIMIT ?
    `),
    lastRunByName: db.prepare(`
      SELECT * FROM runs
      WHERE automation_name = ? AND (? IS NULL OR ok = ?)
      ORDER BY started_at DESC LIMIT 1
    `),
    setPinned: db.prepare(`UPDATE runs SET pinned = ? WHERE run_id = ?`),
    pinnedRunByName: db.prepare(`
      SELECT * FROM runs
      WHERE automation_name = ? AND pinned = 1
      ORDER BY started_at DESC LIMIT 1
    `),
    listChildRunsByParent: db.prepare(`
      SELECT * FROM runs WHERE parent_run_id = ? ORDER BY started_at ASC
    `),
    insertNode: db.prepare(`
      INSERT INTO run_nodes (
        node_id, run_id, ordinal, batch_id, kind, name,
        args_json, output_json, ok, error,
        started_at, ended_at, duration_ms, input_tokens, output_tokens, child_run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    listNodesByRun: db.prepare(`
      SELECT * FROM run_nodes WHERE run_id = ? ORDER BY ordinal ASC, started_at ASC
    `),
    upsertState: db.prepare(`
      INSERT INTO state (automation_name, key, value_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(automation_name, key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `),
    getState: db.prepare(`SELECT * FROM state WHERE automation_name = ? AND key = ?`),
    deleteState: db.prepare(`DELETE FROM state WHERE automation_name = ? AND key = ?`),
    pruneByCount: db.prepare(`
      DELETE FROM runs
      WHERE automation_name = ?
        AND pinned = 0
        AND run_id NOT IN (
          SELECT run_id FROM runs WHERE automation_name = ? ORDER BY started_at DESC LIMIT ?
        )
    `),
    pruneByDays: db.prepare(
      `DELETE FROM runs WHERE automation_name = ? AND pinned = 0 AND started_at < ?`,
    ),
    pruneErrorsOnly: db.prepare(
      `DELETE FROM runs WHERE automation_name = ? AND pinned = 0 AND ok = 1`,
    ),
    countRunsByName: db.prepare(`SELECT COUNT(*) AS c FROM runs WHERE automation_name = ?`),
  };
}

/**
 * Lazy wrapper around the per-app `automations.sqlite` connection.
 *
 * Construct once per app at the call site that owns the run lifecycle
 * (automation-handler-runner). The file is opened on first method call
 * — opening it eagerly would create the file before any automation has
 * fired, which the issue explicitly forbids.
 */
export class AutomationRunsStore {
  private readonly dbPath: string;
  private db: DatabaseSync | undefined;
  private stmts: PreparedStatements | undefined;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  private ensureReady(): { db: DatabaseSync; stmts: PreparedStatements } {
    if (this.db && this.stmts) return { db: this.db, stmts: this.stmts };
    const db = openAutomationsDb(this.dbPath);
    const stmts = prepare(db);
    this.db = db;
    this.stmts = stmts;
    return { db, stmts };
  }

  insertRun(input: InsertRunInput): void {
    const { stmts } = this.ensureReady();
    stmts.insertRun.run(
      input.runId,
      input.automationName,
      input.triggerKind,
      input.parentRunId ?? null,
      input.inputJson ?? null,
      input.startedAt,
    );
  }

  finishRun(input: FinishRunInput): void {
    const { stmts } = this.ensureReady();
    stmts.finishRun.run(
      input.endedAt,
      input.ok ? 1 : 0,
      input.error ?? null,
      input.summary ?? null,
      input.outputJson ?? null,
      input.runId,
    );
  }

  getRun(runId: string): AutomationRunRow | undefined {
    const { stmts } = this.ensureReady();
    const raw = stmts.getRun.get(runId) as RawRun | undefined;
    return raw ? runFromRaw(raw) : undefined;
  }

  listRuns(opts: ListRunsOptions = {}): AutomationRunRow[] {
    const { stmts } = this.ensureReady();
    const limit = opts.limit ?? 50;
    const since = opts.since ?? null;
    // `status` is pushed into the SQL predicate (not filtered after LIMIT)
    // so `{ status: 'ok', limit: N }` returns N successful runs even when
    // recent failures would otherwise crowd them out of the window.
    const okFilter = opts.status === undefined ? null : opts.status === 'ok' ? 1 : 0;
    const rows =
      opts.name !== undefined
        ? (stmts.listRunsByName.all(
            opts.name,
            since,
            since,
            okFilter,
            okFilter,
            limit,
          ) as unknown as RawRun[])
        : (stmts.listRunsAll.all(since, since, okFilter, okFilter, limit) as unknown as RawRun[]);
    return rows.map(runFromRaw);
  }

  lastRun(name: string, status?: 'ok' | 'error'): AutomationRunRow | undefined {
    const { stmts } = this.ensureReady();
    const okFilter = status === undefined ? null : status === 'ok' ? 1 : 0;
    const raw = stmts.lastRunByName.get(name, okFilter, okFilter) as RawRun | undefined;
    return raw ? runFromRaw(raw) : undefined;
  }

  /**
   * Pin / unpin a run. A pinned run becomes a replay fixture: a
   * `triggerKind: 'replay'` fire serves its recorded `run_nodes` outputs,
   * and retention pruning never drops it.
   */
  setPinned(runId: string, pinned: boolean): void {
    const { stmts } = this.ensureReady();
    stmts.setPinned.run(pinned ? 1 : 0, runId);
  }

  /** Most recent pinned run for an automation, or undefined when none is pinned. */
  pinnedRun(name: string): AutomationRunRow | undefined {
    const { stmts } = this.ensureReady();
    const raw = stmts.pinnedRunByName.get(name) as RawRun | undefined;
    return raw ? runFromRaw(raw) : undefined;
  }

  /** Child runs spawned by `ctx.invoke` from the given parent, oldest first. */
  listChildRuns(parentRunId: string): AutomationRunRow[] {
    const { stmts } = this.ensureReady();
    const rows = stmts.listChildRunsByParent.all(parentRunId) as unknown as RawRun[];
    return rows.map(runFromRaw);
  }

  insertNode(input: InsertNodeInput): void {
    const { stmts } = this.ensureReady();
    stmts.insertNode.run(
      input.nodeId,
      input.runId,
      input.ordinal,
      input.batchId ?? null,
      input.kind,
      input.name,
      input.argsJson ?? null,
      input.outputJson ?? null,
      input.ok ? 1 : 0,
      input.error ?? null,
      input.startedAt,
      input.endedAt,
      input.durationMs,
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      input.childRunId ?? null,
    );
  }

  listNodes(runId: string): AutomationRunNodeRow[] {
    const { stmts } = this.ensureReady();
    const rows = stmts.listNodesByRun.all(runId) as unknown as RawNode[];
    return rows.map(nodeFromRaw);
  }

  stateGet(name: string, key: string): AutomationStateEntry | undefined {
    const { stmts } = this.ensureReady();
    const raw = stmts.getState.get(name, key) as RawState | undefined;
    return raw ? stateFromRaw(raw) : undefined;
  }

  stateSet(name: string, key: string, valueJson: string, updatedAt: number): void {
    const { stmts } = this.ensureReady();
    stmts.upsertState.run(name, key, valueJson, updatedAt);
  }

  stateDelete(name: string, key: string): void {
    const { stmts } = this.ensureReady();
    stmts.deleteState.run(name, key);
  }

  countRuns(name: string): number {
    const { stmts } = this.ensureReady();
    const raw = stmts.countRunsByName.get(name) as { c: number } | undefined;
    return raw?.c ?? 0;
  }

  /**
   * Apply a `history.keep` retention policy for an automation. Cascading
   * FKs drop the orphaned `run_nodes`. Runs at end-of-run (resolved per
   * the issue's "retention timing" open question).
   */
  prune(
    name: string,
    keep: { count?: number; days?: number; errorsOnly?: boolean; all?: boolean },
  ): void {
    const { stmts } = this.ensureReady();
    if (keep.all) return;
    if (keep.errorsOnly) {
      stmts.pruneErrorsOnly.run(name);
      return;
    }
    if (keep.count !== undefined && keep.count >= 0) {
      stmts.pruneByCount.run(name, name, keep.count);
      return;
    }
    if (keep.days !== undefined && keep.days >= 0) {
      const cutoff = Date.now() - keep.days * 24 * 60 * 60 * 1000;
      stmts.pruneByDays.run(name, cutoff);
    }
  }

  close(): void {
    if (!this.db) return;
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
    this.db = undefined;
    this.stmts = undefined;
  }
}
