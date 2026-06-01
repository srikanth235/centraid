/*
 * @centraid/analytics
 *
 * Centraid's Insights domain — neither the per-app engine nor the per-app run
 * ledger, so it lives beside app-engine, not inside it (#151):
 *
 *   - AnalyticsStore — push-based central run summaries. Implements
 *     app-engine's `RunSummarySink`, so `AgentRunsStore.finishRun` can
 *     write-through one row per run without app-engine depending on this
 *     package. Backed by the central `centraid-analytics.sqlite`.
 *   - InsightsStore — read-only aggregation over those summaries; the single
 *     source for the desktop Insights screen.
 *   - The `centraid-analytics.sqlite` migration ladder + provider
 *     (`analytics-db.ts`) — this package owns its schema, built through
 *     app-engine's shared `makeMigratedDbProvider` so it opens with the same
 *     WAL/pragma/migrate seam as every other centraid SQLite file.
 *
 * One-way dependency: this package depends on `@centraid/app-engine` (for the
 * `DatabaseProvider` seam, the `RunSummary` / `RunSummarySink` contract, and
 * the shared SQLite-open helper); app-engine never depends back.
 *
 * `UserStore` (identity) deliberately stays in app-engine — app-engine's own
 * HTTP surface (`http-server`/`runtime`) mounts its route, so moving it would
 * invert that seam and create a cycle. See the issue-151 receipt.
 */

export { AnalyticsStore, type ListSummariesOptions } from './analytics-store.js';
export { openAnalyticsDb, makeAnalyticsDbProvider, ANALYTICS_MIGRATIONS } from './analytics-db.js';
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
