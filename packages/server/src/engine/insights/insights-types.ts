/*
 * Insights payload types for InsightsStore (#514).
 * Kept separate so the store file stays under the repo-hygiene line limit.
 */

export interface InsightsKpis {
  /** input + output + cache read + cache write over the window. */
  totalTokens: number;
  /** Estimated handoff prompt tokens, a subset marker separate from usage. */
  hydrationTokens: number;
  /**
   * Sum of known costs — a floor when unpricedRuns > 0.
   * harnessReportedCostUsd + estimatedCostUsd (+ digest totals).
   */
  totalCostUsd: number;
  /** USD from items with cost_source = 'harness' (live). */
  harnessReportedCostUsd: number;
  /** USD from catalog estimates (live). */
  estimatedCostUsd: number;
  /** Window run-rate projected to a 30-day month (priced totals only). */
  forecastCostUsd: number;
  generations: number;
  retries: number;
  failedRuns: number;
  /** Spend on failed runs (floor of known failed cost). */
  failedCostUsd: number;
  appsTouched: number;
  /** Finished LIVE runs with total_cost_usd IS NULL. */
  unpricedRuns: number;
  /** Finished LIVE runs with zero/NULL token totals. */
  unreportedRuns: number;
}

export interface InsightsDailyPoint {
  /** `YYYY-MM-DD` (UTC). */
  date: string;
  tokens: number;
  costUsd: number;
  runs: number;
}

export interface InsightsSourceRow {
  /** `<appId>/<id>` automation handle, or the bucket key `chat` / `build`. */
  key: string;
  label: string;
  kind: string;
  runs: number;
  tokens: number;
  costUsd: number;
  automationName?: string;
}

export interface InsightsHarnessRow {
  /** ACP stamps harness = HarnessKind; "unknown" when missing. */
  harness: string;
  runs: number;
  tokens: number;
  costUsd: number;
}

export interface InsightsModelRow {
  model: string;
  runs: number;
  tokens: number;
  costUsd: number;
}

export interface InsightsEffortRow {
  /** ACP semantic thought_level confirmed by the harness. */
  effort: string;
  runs: number;
  tokens: number;
  costUsd: number;
}

export interface InsightsActivityRow {
  runId: string;
  kind: string;
  label: string;
  automationRef?: string;
  automationName?: string;
  ok: boolean;
  startedAt: number;
  tokens: number;
  /** Estimated canonical-ledger prompt tokens injected for this run. */
  hydrationTokens: number;
  costUsd: number;
  harness?: string;
  model?: string;
  effort?: string;
}

export interface InsightsPeakDay {
  date: string;
  tokens: number;
  costUsd: number;
  topSources: Array<{
    key: string;
    label: string;
    kind: string;
    tokens: number;
    costUsd: number;
  }>;
}

export interface InsightsAttention {
  kind: "top_source";
  key: string;
  label: string;
  kindLabel: string;
  share: number;
  costUsd: number;
}

export interface InsightsSummary {
  windowDays: number;
  generatedAt: number;
  kpis: InsightsKpis;
  daily: InsightsDailyPoint[];
  bySource: InsightsSourceRow[];
  byHarness: InsightsHarnessRow[];
  byModel: InsightsModelRow[];
  byEffort: InsightsEffortRow[];
  recent: InsightsActivityRow[];
  peakDay?: InsightsPeakDay;
  attention?: InsightsAttention;
}
