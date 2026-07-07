/*
 * Insights — app-engine's reporting sub-module (`insights/`).
 *
 * Folded into app-engine from the former `@centraid/analytics` package (#151),
 * but kept behind this barrel and a one-way internal boundary: `insights/`
 * imports from the rest of app-engine (the `DatabaseProvider` seam, the
 * `RunSummary` DTO), and nothing in app-engine imports back into `insights/`.
 * It is neither the per-app engine nor the per-app run ledger, so it stays
 * its own folder rather than dissolving into the package root.
 *
 *   - AnalyticsStore — read-only lens over the vault's `run_summary` VIEW
 *     in `journal.db` (the old write-through table is gone; the ledger
 *     tables are the source). Per-vault, so it can never aggregate across
 *     vaults (#280).
 *   - InsightsStore — read-only aggregation over those summaries; the single
 *     source for the desktop Insights screen. Follows the active vault.
 *
 * Re-exported from the app-engine package barrel; consumers import these
 * symbols from `@centraid/app-engine`. The `RunSummary` DTO is exported from
 * the package root directly (it lives in `run-summary-sink.ts`), so it is
 * intentionally not re-exported here.
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
