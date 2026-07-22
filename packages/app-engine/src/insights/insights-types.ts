/*
 * Insights payload types for InsightsStore (#514).
 * Kept separate so the store file stays under the repo-hygiene line limit.
 */

export interface InsightsKpis {
  /** input + output + cache read + cache write over the window. */
  totalTokens: number;
  /**
   * Sum of known costs — a floor when unpricedRuns > 0.
   * agentReportedCostUsd + estimatedCostUsd (+ digest totals).
   */
  totalCostUsd: number;
  /** USD from items with cost_source = 'agent' (live). */
  agentReportedCostUsd: number;
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

export interface InsightsRunnerRow {
  /** ACP stamps provider = RunnerKind; "unknown" when missing. */
  provider: string;
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

export interface InsightsActivityRow {
  runId: string;
  kind: string;
  label: string;
  automationRef?: string;
  automationName?: string;
  ok: boolean;
  startedAt: number;
  tokens: number;
  costUsd: number;
  provider?: string;
  model?: string;
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
  kind: 'top_source';
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
  byRunner: InsightsRunnerRow[];
  byModel: InsightsModelRow[];
  recent: InsightsActivityRow[];
  peakDay?: InsightsPeakDay;
  attention?: InsightsAttention;
}
