/*
 * `RunSummary` — one row per finished agent run (chat turn, automation fire,
 * or builder iteration), the shape the Insights/Executions surfaces read.
 *
 * Historically this file also declared a `RunSummarySink` write-through seam:
 * the ledger pushed a denormalized summary row into a separate analytics DB
 * at `finishTurn`. That seam is gone — `run_summary` is now a SQL VIEW over
 * the ledger tables in the same `journal.db` (see `CONVERSATION_LEDGER_DDL`),
 * so the ledger IS the source and `AnalyticsStore` in `insights/` is a
 * read-only lens over the view. The DTO stays here at the package root so
 * the `insights/` boundary remains one-way (#151).
 */

import type { RunKind } from './schema.js';

/**
 * One summary row per agent run, as surfaced by the `run_summary` view.
 * Token totals and cost come from the turn's finish-time rollup columns;
 * `model` is the run's dominant model (most tokens) from its step items.
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
  /** Replay-fixture pin — the turn's own `pinned` flag. */
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
