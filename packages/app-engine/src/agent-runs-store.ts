/*
 * AgentRunsStore — agent-run ledger + automation KV.
 *
 * The three tables — `runs`, `run_nodes`, `automation_state` — are the
 * `RUNTIME_MIGRATIONS` / `ACTIVITY_MIGRATIONS` shape in `gateway-db.ts`.
 *
 *   runs             — one row per agent run (chat turn / automation
 *                      fire / builder iteration; `kind` discriminates).
 *                      Carries parent_run_id for sub-runs, a run
 *                      summary, validated output_json, and a
 *                      denormalized token/cost rollup.
 *   run_nodes        — the ordered agentic trace: one `kind='step'` row
 *                      per primary model-inference call, plus `tool` /
 *                      `agent` / `invoke` audit rows.
 *   automation_state — per-(automation_id, key) KV.
 *
 * Issue #98: an automation's run ledger is per-app — the store is
 * constructed over that app's `runtime.sqlite`; a chat run's ledger is
 * `centraid-activity.sqlite`. Either way the store is runtime-owned: it
 * is never reachable from the handler's `db` proxy or the
 * `centraid_sql_*` agent tools (those only see an app's `data.sqlite`).
 * When an `AnalyticsStore` is supplied, `finishRun` write-throughs a
 * one-row summary to the central analytics DB.
 *
 * Row types live in `agent-runs-schema.ts`; the prepared-statement
 * block + raw-row mappers live in `agent-runs-store-sql.ts`.
 */

import { type DatabaseSync } from 'node:sqlite';
import type { DatabaseProvider } from './gateway-db.js';
import type { AnalyticsStore } from './analytics-store.js';
import type {
  AgentRunRow,
  AgentRunNodeRow,
  AutomationStateEntry,
  AutomationTriggerKind,
  AutomationTriggerOrigin,
  AgentRunNodeKind,
  RunKind,
} from './agent-runs-schema.js';
import {
  prepare,
  runFromRaw,
  nodeFromRaw,
  stateFromRaw,
  type PreparedStatements,
  type RawRun,
  type RawNode,
  type RawState,
} from './agent-runs-store-sql.js';

export interface InsertRunInput {
  readonly runId: string;
  readonly triggerKind: AutomationTriggerKind;
  /** Source that fired the run (`cron` / `webhook` / `manual`). */
  readonly triggerOrigin?: AutomationTriggerOrigin;
  /** Defaults to `'automation'`. */
  readonly kind?: RunKind;
  /** UUID of the automation — set for `kind: 'automation'`. */
  readonly automationId?: string;
  readonly parentRunId?: string;
  readonly chatSessionId?: string;
  readonly appId?: string;
  readonly note?: string;
  readonly retryOf?: string;
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
  readonly kind: AgentRunNodeKind;
  /** The tool name or sub-run target. Omitted for `kind: 'step'`. */
  readonly name?: string;
  readonly argsJson?: string;
  readonly outputJson?: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly durationMs: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  /** `step` / `agent` — the model + provider that served the call. */
  readonly model?: string;
  readonly provider?: string;
  /** Frozen at write time from the per-model price table. */
  readonly costUsd?: number;
  /** `tool` / `agent` / `invoke` — the app whose data the call touched. */
  readonly appId?: string;
  readonly childRunId?: string;
}

export interface ListRunsOptions {
  /** When set, scope to one automation's runs. */
  readonly automationId?: string;
  readonly status?: 'ok' | 'error';
  readonly since?: number;
  readonly limit?: number;
}

/**
 * Store over the activity DB's unified ledger tables.
 *
 * Construct with a shared `DatabaseProvider` (the same one `UserStore`
 * / `ChatHistoryStore` / `AutomationStore` use). The connection is
 * opened lazily by the provider on first method call.
 */
export class AgentRunsStore {
  private readonly provider: DatabaseProvider;
  private readonly analytics: AnalyticsStore | undefined;
  private db: DatabaseSync | undefined;
  private stmts: PreparedStatements | undefined;

  /**
   * Construct over a run-ledger `DatabaseProvider` — a per-app
   * `runtime.sqlite` for automation runs, or `centraid-activity.sqlite`
   * for chat runs. When an `analytics` store is supplied, `finishRun`
   * write-throughs a summary row to the central analytics DB
   * (best-effort — issue #98, decision 4).
   */
  constructor(provider: DatabaseProvider, analytics?: AnalyticsStore) {
    this.provider = provider;
    this.analytics = analytics;
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
      input.kind ?? 'automation',
      input.automationId ?? null,
      input.chatSessionId ?? null,
      input.appId ?? null,
      input.triggerKind,
      input.triggerOrigin ?? null,
      input.parentRunId ?? null,
      input.retryOf ?? null,
      input.note ?? null,
      input.inputJson ?? null,
      input.startedAt,
    );
  }

  finishRun(input: FinishRunInput): void {
    const { stmts } = this.ensureReady();
    stmts.finishRun.run({
      endedAt: input.endedAt,
      ok: input.ok ? 1 : 0,
      error: input.error ?? null,
      summary: input.summary ?? null,
      outputJson: input.outputJson ?? null,
      rid: input.runId,
    });
    if (this.analytics) this.writeRunSummary(input.runId);
  }

  /**
   * Write-through this run's one-row summary to the central analytics
   * DB. Best-effort — an analytics-DB failure is swallowed so it never
   * fails the run; the run ledger here stays authoritative.
   */
  private writeRunSummary(runId: string): void {
    if (!this.analytics) return;
    try {
      const { stmts } = this.ensureReady();
      const row = this.getRun(runId);
      if (!row) return;
      const dom = stmts.dominantModel.get(runId) as { model: string } | undefined;
      // For an automation run, `automation_id` is the `<appId>/<id>`
      // handle; the app id is the segment before the slash.
      const automationRef = row.kind === 'automation' ? row.automationId : undefined;
      const slash = automationRef ? automationRef.indexOf('/') : -1;
      const appId = slash > 0 ? automationRef!.slice(0, slash) : row.appId;
      this.analytics.recordRunSummary({
        runId: row.runId,
        kind: row.kind,
        ...(automationRef !== undefined ? { automationRef } : {}),
        ...(appId !== undefined ? { appId } : {}),
        trigger: row.triggerKind,
        ...(row.triggerOrigin !== undefined ? { triggerOrigin: row.triggerOrigin } : {}),
        ok: row.ok,
        pinned: row.pinned,
        ...(row.summary !== undefined ? { summary: row.summary } : {}),
        ...(row.note !== undefined ? { note: row.note } : {}),
        ...(row.error !== undefined ? { error: row.error } : {}),
        ...(row.retryOf !== undefined ? { retryOf: row.retryOf } : {}),
        ...(dom?.model ? { model: dom.model } : {}),
        startedAt: row.startedAt,
        ...(row.endedAt !== undefined ? { endedAt: row.endedAt } : {}),
        ...(row.totalInputTokens !== undefined ? { totalInputTokens: row.totalInputTokens } : {}),
        ...(row.totalOutputTokens !== undefined
          ? { totalOutputTokens: row.totalOutputTokens }
          : {}),
        ...(row.totalCacheReadTokens !== undefined
          ? { totalCacheReadTokens: row.totalCacheReadTokens }
          : {}),
        ...(row.totalCacheWriteTokens !== undefined
          ? { totalCacheWriteTokens: row.totalCacheWriteTokens }
          : {}),
        ...(row.totalCostUsd !== undefined ? { totalCostUsd: row.totalCostUsd } : {}),
        ...(row.stepCount !== undefined ? { stepCount: row.stepCount } : {}),
        ...(row.toolCount !== undefined ? { toolCount: row.toolCount } : {}),
      });
    } catch {
      // Best-effort — see the method doc.
    }
  }

  getRun(runId: string): AgentRunRow | undefined {
    const { stmts } = this.ensureReady();
    const raw = stmts.getRun.get(runId) as RawRun | undefined;
    return raw ? runFromRaw(raw) : undefined;
  }

  listRuns(opts: ListRunsOptions = {}): AgentRunRow[] {
    const { stmts } = this.ensureReady();
    const limit = opts.limit ?? 50;
    const since = opts.since ?? null;
    // `status` is pushed into the SQL predicate (not filtered after LIMIT)
    // so `{ status: 'ok', limit: N }` returns N successful runs even when
    // recent failures would otherwise crowd them out of the window.
    const okFilter = opts.status === undefined ? null : opts.status === 'ok' ? 1 : 0;
    const rows =
      opts.automationId !== undefined
        ? (stmts.listRunsByAutomation.all(
            opts.automationId,
            since,
            since,
            okFilter,
            okFilter,
            limit,
          ) as unknown as RawRun[])
        : (stmts.listRunsAll.all(since, since, okFilter, okFilter, limit) as unknown as RawRun[]);
    return rows.map(runFromRaw);
  }

  /** Every run for a chat session, oldest first — the conversation's turns. */
  listChatRuns(chatSessionId: string): AgentRunRow[] {
    const { stmts } = this.ensureReady();
    const rows = stmts.listRunsByChatSession.all(chatSessionId) as unknown as RawRun[];
    return rows.map(runFromRaw);
  }

  lastRun(automationId: string, status?: 'ok' | 'error'): AgentRunRow | undefined {
    const { stmts } = this.ensureReady();
    const okFilter = status === undefined ? null : status === 'ok' ? 1 : 0;
    const raw = stmts.lastRunByAutomation.get(automationId, okFilter, okFilter) as
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
  pinnedRun(automationId: string): AgentRunRow | undefined {
    const { stmts } = this.ensureReady();
    const raw = stmts.pinnedRunByAutomation.get(automationId) as RawRun | undefined;
    return raw ? runFromRaw(raw) : undefined;
  }

  /** Child runs spawned as sub-runs of the given parent, oldest first. */
  listChildRuns(parentRunId: string): AgentRunRow[] {
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
      input.model ?? null,
      input.provider ?? null,
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      input.cacheReadTokens ?? null,
      input.cacheWriteTokens ?? null,
      input.costUsd ?? null,
      input.appId ?? null,
      input.name ?? null,
      input.argsJson ?? null,
      input.outputJson ?? null,
      input.childRunId ?? null,
      input.ok ? 1 : 0,
      input.error ?? null,
      input.startedAt,
      input.endedAt,
      input.durationMs,
    );
  }

  listNodes(runId: string): AgentRunNodeRow[] {
    const { stmts } = this.ensureReady();
    const rows = stmts.listNodesByRun.all(runId) as unknown as RawNode[];
    return rows.map(nodeFromRaw);
  }

  stateGet(automationId: string, key: string): AutomationStateEntry | undefined {
    const { stmts } = this.ensureReady();
    const raw = stmts.getState.get(automationId, key) as RawState | undefined;
    return raw ? stateFromRaw(raw) : undefined;
  }

  stateSet(automationId: string, key: string, valueJson: string, updatedAt: number): void {
    const { stmts } = this.ensureReady();
    stmts.upsertState.run(automationId, key, valueJson, updatedAt);
  }

  stateDelete(automationId: string, key: string): void {
    const { stmts } = this.ensureReady();
    stmts.deleteState.run(automationId, key);
  }

  countRuns(automationId: string): number {
    const { stmts } = this.ensureReady();
    const raw = stmts.countRunsByAutomation.get(automationId) as { c: number } | undefined;
    return raw?.c ?? 0;
  }

  /**
   * Apply a `history.keep` retention policy for an automation. Cascading
   * FKs drop the orphaned `run_nodes`. Runs at end-of-run.
   */
  prune(
    automationId: string,
    keep: { count?: number; days?: number; errorsOnly?: boolean; all?: boolean },
  ): void {
    const { stmts } = this.ensureReady();
    if (keep.all) return;
    if (keep.errorsOnly) {
      stmts.pruneErrorsOnly.run(automationId);
      return;
    }
    if (keep.count !== undefined && keep.count >= 0) {
      stmts.pruneByCount.run(automationId, automationId, keep.count);
      return;
    }
    if (keep.days !== undefined && keep.days >= 0) {
      const cutoff = Date.now() - keep.days * 24 * 60 * 60 * 1000;
      stmts.pruneByDays.run(automationId, cutoff);
    }
  }

  /**
   * Drop every run + state row for one automation. `run_nodes` cascade
   * off `runs`. Called when the automation is deleted.
   */
  deleteAutomationData(automationId: string): void {
    const { stmts } = this.ensureReady();
    stmts.deleteRunsByAutomation.run(automationId);
    stmts.deleteStateByAutomation.run(automationId);
  }

  /**
   * No-op. The activity DB connection is owned by the host's
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
