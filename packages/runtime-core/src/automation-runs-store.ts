/*
 * AutomationRunsStore — automation run audit + ctx.state surface.
 *
 * The three tables — `automation_runs`, `automation_run_nodes`,
 * `automation_state` — live in the automations DB
 * (`centraid-automations.sqlite`), alongside the `automations` mirror.
 * The DDL is in `gateway-db.ts` AUTOMATION_MIGRATIONS[1]. Keeping the
 * audit in one file (rather than a per-app `automations.sqlite`) lets a
 * cross-app `ctx.invoke` child run link its `parent_run_id` self-FK
 * into one joinable DAG — a self-FK can't cross SQLite files.
 *
 *   automation_runs       — one row per automation fire (scheduled/
 *                           manual/replay/on_failure). Carries
 *                           parent_run_id for sub-invocations,
 *                           handler-return summary, validated
 *                           output_json, an `origin_app_id`.
 *   automation_run_nodes  — one row per ctx.tool / ctx.agent /
 *                           ctx.invoke call inside a run.
 *                           Promise.all-batched calls share a
 *                           `batch_id`.
 *   automation_state      — per-(origin_app_id, automation_name, key)
 *                           KV used by ctx.state.
 *
 * The store is runtime-owned: it is never reachable from the handler's
 * `db` proxy or the `centraid_sql_*` agent tools (those only ever see
 * an app's `data.sqlite`).
 *
 * Each store instance is bound to one `originAppId`; name-scoped reads
 * and writes are filtered to that app. `forApp(otherId)` returns a
 * sibling store sharing the same `DatabaseProvider` (same cached
 * connection) bound to a different app — used by cross-app `ctx.invoke`
 * so a child run is recorded under the target app.
 *
 * Row types live in `automation-runs-schema.ts`; the prepared-statement
 * block + raw-row mappers live in `automation-runs-store-sql.ts`.
 */

import { type DatabaseSync } from 'node:sqlite';
import type { DatabaseProvider } from './gateway-db.js';
import type {
  AutomationRunRow,
  AutomationRunNodeRow,
  AutomationStateEntry,
  AutomationTriggerKind,
  AutomationRunNodeKind,
} from './automation-runs-schema.js';
import {
  prepare,
  runFromRaw,
  nodeFromRaw,
  stateFromRaw,
  type PreparedStatements,
  type RawRun,
  type RawNode,
  type RawState,
} from './automation-runs-store-sql.js';

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

/**
 * Store over the gateway DB's automation run-audit tables.
 *
 * Construct with a shared `DatabaseProvider` (the same one `UserStore`
 * / `ChatHistoryStore` / `AutomationStore` use) and the `originAppId`
 * the store's name-scoped reads/writes belong to. The connection is
 * opened lazily by the provider on first method call.
 */
export class AutomationRunsStore {
  private readonly provider: DatabaseProvider;
  private readonly originAppId: string | null;
  private db: DatabaseSync | undefined;
  private stmts: PreparedStatements | undefined;

  constructor(provider: DatabaseProvider, originAppId: string | null) {
    this.provider = provider;
    this.originAppId = originAppId;
  }

  /**
   * Return a sibling store bound to a different app, sharing this
   * store's provider (so they share one cached connection). Used by
   * cross-app `ctx.invoke` so the child run is recorded under the
   * target app.
   */
  forApp(originAppId: string): AutomationRunsStore {
    return new AutomationRunsStore(this.provider, originAppId);
  }

  private ensureReady(): { db: DatabaseSync; stmts: PreparedStatements } {
    if (this.db && this.stmts) return { db: this.db, stmts: this.stmts };
    const db = this.provider();
    const stmts = prepare(db);
    this.db = db;
    this.stmts = stmts;
    return { db, stmts };
  }

  insertRun(input: InsertRunInput): void {
    const { stmts } = this.ensureReady();
    stmts.insertRun.run(
      input.runId,
      this.originAppId,
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
            this.originAppId,
            since,
            since,
            okFilter,
            okFilter,
            limit,
          ) as unknown as RawRun[])
        : (stmts.listRunsAll.all(
            this.originAppId,
            since,
            since,
            okFilter,
            okFilter,
            limit,
          ) as unknown as RawRun[]);
    return rows.map(runFromRaw);
  }

  lastRun(name: string, status?: 'ok' | 'error'): AutomationRunRow | undefined {
    const { stmts } = this.ensureReady();
    const okFilter = status === undefined ? null : status === 'ok' ? 1 : 0;
    const raw = stmts.lastRunByName.get(name, this.originAppId, okFilter, okFilter) as
      | RawRun
      | undefined;
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
    const raw = stmts.pinnedRunByName.get(name, this.originAppId) as RawRun | undefined;
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
    const raw = stmts.getState.get(this.originAppId, name, key) as RawState | undefined;
    return raw ? stateFromRaw(raw) : undefined;
  }

  stateSet(name: string, key: string, valueJson: string, updatedAt: number): void {
    const { stmts } = this.ensureReady();
    stmts.upsertState.run(this.originAppId, name, key, valueJson, updatedAt);
  }

  stateDelete(name: string, key: string): void {
    const { stmts } = this.ensureReady();
    stmts.deleteState.run(this.originAppId, name, key);
  }

  countRuns(name: string): number {
    const { stmts } = this.ensureReady();
    const raw = stmts.countRunsByName.get(name, this.originAppId) as { c: number } | undefined;
    return raw?.c ?? 0;
  }

  /**
   * Apply a `history.keep` retention policy for an automation. Cascading
   * FKs drop the orphaned `automation_run_nodes`. Runs at end-of-run
   * (resolved per the issue's "retention timing" open question).
   */
  prune(
    name: string,
    keep: { count?: number; days?: number; errorsOnly?: boolean; all?: boolean },
  ): void {
    const { stmts } = this.ensureReady();
    if (keep.all) return;
    if (keep.errorsOnly) {
      stmts.pruneErrorsOnly.run(name, this.originAppId);
      return;
    }
    if (keep.count !== undefined && keep.count >= 0) {
      stmts.pruneByCount.run(name, this.originAppId, name, this.originAppId, keep.count);
      return;
    }
    if (keep.days !== undefined && keep.days >= 0) {
      const cutoff = Date.now() - keep.days * 24 * 60 * 60 * 1000;
      stmts.pruneByDays.run(name, this.originAppId, cutoff);
    }
  }

  /**
   * Drop every run + state row for this store's bound `originAppId`.
   * `automation_run_nodes` cascade off `automation_runs`. Called when
   * the owning app is deregistered.
   */
  deleteAppData(): void {
    const { stmts } = this.ensureReady();
    stmts.deleteRunsByApp.run(this.originAppId);
    stmts.deleteStateByApp.run(this.originAppId);
  }

  /**
   * No-op. The gateway DB connection is owned by the host's
   * `DatabaseProvider` and shared with `UserStore` / `ChatHistoryStore`
   * / `AutomationStore` — closing it mid-fire would break them. Kept
   * for call-site compatibility; only the cached prepared statements
   * are cleared.
   */
  close(): void {
    this.db = undefined;
    this.stmts = undefined;
  }
}
