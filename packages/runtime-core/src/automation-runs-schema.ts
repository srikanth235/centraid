/*
 * Automation run-audit row types.
 *
 * Pure types — the table DDL lives in `gateway-db.ts` (MIGRATIONS[2]:
 * `automation_runs`, `automation_run_nodes`, `automation_state`). These
 * shapes are exported separately so callers (the SQLite-backed store in
 * `automation-runs-store.ts` and the desktop UI) can import the row
 * types without pulling in the store implementation.
 */

export type AutomationTriggerKind = 'scheduled' | 'manual' | 'replay' | 'on_failure';
export type AutomationRunNodeKind = 'tool' | 'agent' | 'invoke';

export interface AutomationRunRow {
  readonly runId: string;
  readonly automationName: string;
  readonly triggerKind: AutomationTriggerKind;
  readonly parentRunId?: string;
  readonly inputJson?: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly ok: boolean;
  readonly error?: string;
  readonly summary?: string;
  readonly outputJson?: string;
  /**
   * When true the run is a kept fixture: its recorded `run_nodes` can be
   * replayed by a `triggerKind: 'replay'` fire, and retention pruning
   * skips it (issue #80 follow-up — pinned data during builder iteration).
   */
  readonly pinned: boolean;
}

export interface AutomationRunNodeRow {
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
  readonly endedAt?: number;
  readonly durationMs?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /**
   * For `kind: 'invoke'` nodes — the `run_id` of the child run spawned by
   * `ctx.invoke`. All runs (intra- and cross-app) live in the same
   * gateway DB, so the DAG view can nest the child timeline from this
   * link regardless of which app the child belongs to.
   */
  readonly childRunId?: string;
}

export interface AutomationStateEntry {
  readonly automationName: string;
  readonly key: string;
  readonly valueJson: string;
  readonly updatedAt: number;
}
