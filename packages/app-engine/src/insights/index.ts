/*
 * Insights — app-engine's reporting sub-module (`insights/`).
 *
 * Folded into app-engine from the former `@centraid/analytics` package (#151),
 * but kept behind this barrel and a one-way internal boundary: `insights/`
 * imports from the rest of app-engine (the `DatabaseProvider` seam, the
 * `RunSummary` DTO), and nothing in app-engine imports back into `insights/`.
 *
 *   - AnalyticsStore — read-only lens over the vault's `run_summary` VIEW
 *   - InsightsStore — transparency + control aggregates for the Insights UI (#514)
 */

export { AnalyticsStore, type ListSummariesOptions } from './analytics-store.js';
export { InsightsStore } from './insights-store.js';
export type {
  InsightsSummary,
  InsightsKpis,
  InsightsDailyPoint,
  InsightsSourceRow,
  InsightsRunnerRow,
  InsightsModelRow,
  InsightsActivityRow,
  InsightsPeakDay,
  InsightsAttention,
} from './insights-types.js';
/** @deprecated Prefer InsightsSourceRow (#514). */
export type { InsightsSourceRow as InsightsAutomationRow } from './insights-types.js';
