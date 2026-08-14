// Headless Insights aggregation (#775) — the two kits share these folds.
//
// The screens still own their copy and number formatting. This module owns the
// grouping and denominator rules so the desktop and mobile models cannot drift
// while saying the same thing about the same rollup.

import type { DistributionDatum } from "./contracts";

export interface InsightSourceDatum {
  kind: string;
  runs: number;
  costUsd: number;
}

export type InsightSourceBucket = "automations" | "the assistant" | "apps";

export interface InsightSourceRollup {
  bucket: InsightSourceBucket;
  runs: number;
  costUsd: number;
  /** `null` means the window had no runs to use as a denominator. */
  sharePercent: number | null;
}

const SOURCE_BUCKETS: readonly InsightSourceBucket[] = [
  "automations",
  "the assistant",
  "apps",
];

function sourceBucket(kind: string): InsightSourceBucket {
  if (kind === "automation") return "automations";
  if (kind === "chat") return "the assistant";
  return "apps";
}

/** Coalesce source rows into the three buckets in the product's fixed order. */
export function insightSourceRollups(
  rows: readonly InsightSourceDatum[]
): InsightSourceRollup[] {
  const totals = new Map<
    InsightSourceBucket,
    { runs: number; costUsd: number }
  >();
  for (const row of rows) {
    const bucket = sourceBucket(row.kind);
    const previous = totals.get(bucket) ?? { costUsd: 0, runs: 0 };
    totals.set(bucket, {
      costUsd: previous.costUsd + row.costUsd,
      runs: previous.runs + row.runs,
    });
  }
  const totalRuns = [...totals.values()].reduce(
    (sum, total) => sum + total.runs,
    0
  );
  return SOURCE_BUCKETS.flatMap((bucket) => {
    const total = totals.get(bucket);
    if (!total) return [];
    return [
      {
        bucket,
        costUsd: total.costUsd,
        runs: total.runs,
        sharePercent: totalRuns
          ? Math.round((total.runs / totalRuns) * 100)
          : null,
      },
    ];
  });
}

export interface InsightMeasuredDatum {
  id: string;
  label: string;
  costUsd: number;
  tokens: number;
  runs: number;
}

export interface InsightBreakdown {
  rows: DistributionDatum[];
  /** Appended to each row's percentage — "73% of spend". */
  unit: string;
  /** The section head's count line — what the rows are ordered by. */
  meta: string;
}

/** Word one breakdown using the caller's platform-specific number formats. */
export function insightBreakdown(
  items: readonly InsightMeasuredDatum[],
  formatCost: (value: number) => string,
  formatTokens: (value: number) => string,
  formatRuns: (value: number) => string
): InsightBreakdown {
  const totalCost = items.reduce((sum, item) => sum + item.costUsd, 0);
  const byTokens = totalCost <= 0;
  return {
    meta: byTokens ? "sorted by tokens" : "sorted by spend",
    rows: items.map((item) => ({
      id: item.id,
      label: item.label,
      value: `${formatCost(item.costUsd)} · ${formatTokens(item.tokens)} · ${formatRuns(item.runs)}`,
      weight: byTokens ? item.tokens : item.costUsd,
    })),
    unit: byTokens ? "of tokens" : "of spend",
  };
}
