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
 *   - AnalyticsStore — push-based run summaries. Implements app-engine's
 *     `RunSummarySink`, so `finishTurn` can write-through one row per run.
 *     Backed by the vault's own `journal.db` `run_summary` table
 *     (issue #280 — the central `analytics.sqlite` is gone; a per-vault
 *     rollup can never aggregate across vaults).
 *   - InsightsStore — read-only aggregation over those summaries; the single
 *     source for the desktop Insights screen. Follows the active vault.
 *
 * Re-exported from the app-engine package barrel; consumers import these
 * symbols from `@centraid/app-engine`. The `RunSummary` / `RunSummarySink`
 * contract is exported from the package root directly (it lives in
 * `run-summary-sink.ts`), so it is intentionally not re-exported here.
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
