/*
 * @centraid/stores
 *
 * Gateway-scoped stores that are neither the per-app engine nor the per-app
 * run ledger — they live beside app-engine, not inside it (#151):
 *
 *   - AnalyticsStore — push-based central run summaries. Implements
 *     app-engine's `RunSummarySink`, so `AgentRunsStore.finishRun` can
 *     write-through one row per run without app-engine depending on this
 *     package. Backed by the central `centraid-analytics.sqlite`.
 *   - InsightsStore — read-only aggregation over those summaries; the single
 *     source for the desktop Insights screen.
 *
 * One-way dependency: this package depends on `@centraid/app-engine` (for the
 * `DatabaseProvider` seam and the `RunSummary` / `RunSummarySink` contract);
 * app-engine never depends back. The analytics DB ladder + provider stay in
 * app-engine's `gateway-db` (the single WAL/pragma/migrate seam for every
 * centraid SQLite file); a host opens the provider there and injects it here.
 *
 * `UserStore` (identity) deliberately stays in app-engine — app-engine's own
 * HTTP surface (`http-server`/`runtime`) mounts its route, so moving it would
 * invert that seam and create a cycle. See the issue-151 receipt.
 */

export { AnalyticsStore, type ListSummariesOptions } from './analytics-store.js';
export {
  InsightsStore,
  INSIGHTS_QUOTA_TOKENS,
  type InsightsSummary,
  type InsightsKpis,
  type InsightsDailyPoint,
  type InsightsAutomationRow,
  type InsightsModelRow,
  type InsightsActivityRow,
} from './insights-store.js';

// Re-exported for ergonomics so analytics consumers can get the run-summary
// contract from one place; the canonical definitions live in app-engine.
export type { RunSummary, RunSummarySink } from '@centraid/app-engine';
