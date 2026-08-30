export interface InsightsKpis {
  /** input + output + cache read + cache write. */
  totalTokens: number;
  /** Handoff prompt tokens — a subset marker, separate from usage. */
  hydrationTokens: number;
  /** Sum of known costs — a floor when unpricedRuns > 0. */
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
  /** Floor of known failed spend. */
  failedCostUsd: number;
  appsTouched: number;
  /** Finished LIVE runs with total_cost_usd IS NULL. */
  unpricedRuns: number;
  /** Finished LIVE runs with zero/NULL token totals. */
  unreportedRuns: number;
  /**
   * p50 wall clock of finished LIVE runs, in ms. ABSENT when nothing
   * finished — unknown, not zero. Digests keep no per-run timings.
   */
  medianRunMs?: number;
}

export interface InsightsDailyPoint {
  /** `YYYY-MM-DD` (UTC). */
  date: string;
  tokens: number;
  costUsd: number;
  runs: number;
  /** Same predicate as `InsightsKpis`. */
  failedRuns: number;
  /** A FLOOR: digests carry a failure count but no failure-cost split. */
  failedCostUsd: number;
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
  /** ACP thought_level. */
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
  /** Canonical-ledger prompt tokens injected for this run. */
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
