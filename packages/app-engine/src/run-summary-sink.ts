/*
 * The seam between the agent-run ledger and central analytics (the `insights/`
 * sub-module). The ledger builds one `RunSummary` per finished run and pushes
 * it through a `RunSummarySink`; the concrete sink — `AnalyticsStore` in
 * `insights/` — is injected by the host (#151).
 *
 * Keeping the interface here at the package root (not importing `AnalyticsStore`,
 * not living under `insights/`) is what keeps the ledger free of a reporting
 * consumer and the `insights/` boundary one-way: the ledger emits, `insights/`
 * implements. Same injection pattern as `ChatRunner` / `AutomationHost`.
 */

import type { RunKind } from './agent-runs-schema.js';

/**
 * One denormalized row per agent run (chat turn, automation fire, or builder
 * iteration). Built by `AgentRunsStore.finishRun` and written through to the
 * central analytics DB. Frozen at write time — token totals and cost are
 * snapshotted, not recomputed on read.
 */
export interface RunSummary {
  readonly runId: string;
  readonly kind: RunKind;
  /** `<appId>/<id>` handle — set for `kind: 'automation'`. */
  readonly automationRef?: string;
  /** Owning app id — set for automation and build runs. */
  readonly appId?: string;
  readonly trigger: string;
  readonly triggerOrigin?: string;
  readonly ok: boolean;
  /** Replay-fixture pin — kept in sync with the per-app ledger. */
  readonly pinned?: boolean;
  readonly summary?: string;
  readonly note?: string;
  readonly error?: string;
  readonly retryOf?: string;
  /** Dominant model of the run (the one with the most tokens), if any. */
  readonly model?: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly totalInputTokens?: number;
  readonly totalOutputTokens?: number;
  readonly totalCacheReadTokens?: number;
  readonly totalCacheWriteTokens?: number;
  readonly totalCostUsd?: number;
  readonly stepCount?: number;
  readonly toolCount?: number;
}

/**
 * The injected write-through target. `AgentRunsStore` holds an optional
 * `RunSummarySink` and calls `recordRunSummary` from `finishRun`. The call is
 * best-effort at the call site — a sink failure must never fail the run.
 */
export interface RunSummarySink {
  recordRunSummary(s: RunSummary): void;
}
