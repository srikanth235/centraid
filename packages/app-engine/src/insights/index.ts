/*
 * Insights — app-engine's reporting sub-module (`insights/`).
 *
 * Folded into app-engine from the former `@centraid/analytics` package (#151),
 * but kept behind this barrel and a one-way internal boundary: `insights/`
 * imports from the rest of app-engine (the `DatabaseProvider` seam, the
 * `RunSummary` / `RunSummarySink` contract, the shared SQLite-open helper),
 * and nothing in app-engine imports back into `insights/`. It is neither the
 * per-app engine nor the per-app run ledger, so it stays its own folder rather
 * than dissolving into the package root.
 *
 *   - AnalyticsStore — push-based central run summaries. Implements
 *     app-engine's `RunSummarySink`, so `AgentRunsStore.finishRun` can
 *     write-through one row per run. Backed by `centraid-analytics.sqlite`.
 *   - InsightsStore — read-only aggregation over those summaries; the single
 *     source for the desktop Insights screen.
 *   - The `centraid-analytics.sqlite` migration ladder + provider
 *     (`analytics-db.ts`) — this sub-module owns its schema, built through
 *     app-engine's shared `makeMigratedDbProvider` so it opens with the same
 *     WAL/pragma/migrate seam as every other centraid SQLite file.
 *
 * Re-exported from the app-engine package barrel; consumers import these
 * symbols from `@centraid/app-engine`. The `RunSummary` / `RunSummarySink`
 * contract is exported from the package root directly (it lives in
 * `run-summary-sink.ts`), so it is intentionally not re-exported here.
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
