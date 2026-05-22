/*
 * Unified agent-run ledger row types (issue #90, commit 1).
 *
 * Pure types — the table DDL lives in `gateway-db.ts` (ACTIVITY_MIGRATIONS:
 * `runs`, `run_nodes`, `automation_state`). These shapes are exported
 * separately so callers (the SQLite-backed store in
 * `automation-runs-store.ts` and the desktop UI) can import the row
 * types without pulling in the store implementation.
 *
 * A chat turn, an automation fire, and a builder iteration are all the
 * same object — an agent run. `RunKind` discriminates. `run_nodes` is
 * the ordered agentic trace; `AutomationRunNodeKind` discriminates a
 * primary model-inference step from a tool / agent / invoke call.
 */

/** What produced the run. Insights groups `automation` runs by automation. */
export type RunKind = 'automation' | 'chat' | 'build';

/**
 * Why the run fired. `interactive` is a chat turn; the rest are
 * automation fires.
 */
export type AutomationTriggerKind =
  | 'scheduled'
  | 'manual'
  | 'replay'
  | 'on_failure'
  | 'interactive';

/**
 * What *source* fired the run — recorded once an automation can fire
 * from more than one place (issue #96). `cron` is a scheduler fire,
 * `webhook` an inbound HTTP POST, `manual` an explicit "Run now".
 * Distinct from `AutomationTriggerKind`, which records the run's
 * intent rather than its transport.
 */
export type AutomationTriggerOrigin = 'cron' | 'webhook' | 'manual';

/**
 * Trace-node discriminator. `step` is one primary model-inference call —
 * per-call token + cost accounting lives at this grain. `tool` / `agent`
 * / `invoke` are the per-call audit rows.
 */
export type AutomationRunNodeKind = 'step' | 'tool' | 'agent' | 'invoke';

export interface AutomationRunRow {
  readonly runId: string;
  readonly kind: RunKind;
  /** UUID of the automation — set for `kind: 'automation'`. */
  readonly automationId?: string;
  readonly triggerKind: AutomationTriggerKind;
  /** Source that fired the run (`cron` / `webhook` / `manual`). */
  readonly triggerOrigin?: AutomationTriggerOrigin;
  readonly parentRunId?: string;
  /** Set for `kind: 'chat'` — the conversation container. */
  readonly chatSessionId?: string;
  /** Set for `kind: 'build'` — the app being built. */
  readonly appId?: string;
  /** One-line human-readable label for the activity feed. */
  readonly note?: string;
  /** When this run is a retry, the run id it re-runs. */
  readonly retryOf?: string;
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
  /**
   * Denormalized rollup, written at finish. Token sums + cost are Σ over
   * this run's own `kind IN ('step','agent')` nodes — exclusive of
   * child-`invoke` runs, so a SUM over every run is the true grand total
   * with no double-count. Null on an in-flight or crashed run.
   */
  readonly totalInputTokens?: number;
  readonly totalOutputTokens?: number;
  readonly totalCacheReadTokens?: number;
  readonly totalCacheWriteTokens?: number;
  readonly totalCostUsd?: number;
  readonly stepCount?: number;
  readonly toolCount?: number;
}

export interface AutomationRunNodeRow {
  readonly nodeId: string;
  readonly runId: string;
  readonly ordinal: number;
  readonly batchId?: number;
  readonly kind: AutomationRunNodeKind;
  /** The tool name or `ctx.invoke` target. Absent for `kind: 'step'`. */
  readonly name?: string;
  readonly argsJson?: string;
  readonly outputJson?: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly durationMs?: number;
  /** `step` / `agent` — per-call token usage. */
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  /** `step` / `agent` — the model + provider that served the call. */
  readonly model?: string;
  readonly provider?: string;
  /** Frozen at write time from the per-model price table; NULL = no price known. */
  readonly costUsd?: number;
  /** `tool` / `agent` / `invoke` — the app whose data the call touched. */
  readonly appId?: string;
  /**
   * For `kind: 'invoke'` nodes — the `run_id` of the child run spawned by
   * `ctx.invoke`. All runs (intra- and cross-app) live in the same
   * activity DB, so the DAG view can nest the child timeline from this
   * link regardless of which app the child belongs to.
   */
  readonly childRunId?: string;
}

export interface AutomationStateEntry {
  readonly automationId: string;
  readonly key: string;
  readonly valueJson: string;
  readonly updatedAt: number;
}
