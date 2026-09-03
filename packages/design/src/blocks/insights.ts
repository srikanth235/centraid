import { barShares, dayFold, dayMark } from "./bars";
import type {
  DistributionDatum,
  PanelFactData,
  PanelFigureData,
} from "./contracts";

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
  unit: string;
  meta: string;
}

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

export interface InsightWords {
  cost: (value: number) => string;
  count: (value: number) => string;
  duration: (value: number) => string;
  forecastNote: string;
}

export interface InsightRollupKpis {
  totalTokens: number;
  hydrationTokens: number;
  totalCostUsd: number;
  harnessReportedCostUsd: number;
  estimatedCostUsd: number;
  forecastCostUsd: number;
  generations: number;
  retries: number;
  failedRuns: number;
  failedCostUsd: number;
  unpricedRuns: number;
  unreportedRuns: number;
  medianRunMs?: number;
}

export interface InsightDayRow {
  date: string;
  tokens: number;
  costUsd: number;
  runs: number;
  failedRuns: number;
  failedCostUsd: number;
}

export interface InsightRollup {
  generatedAt: number;
  kpis: InsightRollupKpis;
  daily: readonly InsightDayRow[];
  bySource: readonly {
    key: string;
    label: string;
    kind: string;
    runs: number;
    tokens: number;
    costUsd: number;
  }[];
  byHarness: readonly {
    harness: string;
    runs: number;
    tokens: number;
    costUsd: number;
  }[];
  byModel: readonly {
    model: string;
    runs: number;
    tokens: number;
    costUsd: number;
  }[];
  byEffort: readonly {
    effort: string;
    runs: number;
    tokens: number;
    costUsd: number;
  }[];
  peakDay?: {
    date: string;
    tokens: number;
    costUsd: number;
    topSources: readonly { label: string }[];
  };
  attention?: { label: string; share: number };
}

export function insightRunWord(runs: number): string {
  return `${runs.toLocaleString()} ${runs === 1 ? "run" : "runs"}`;
}

export function insightColumnCount(windowDays: number, max: number): number {
  return Math.max(1, Math.min(windowDays, max));
}

export interface InsightColumn {
  key: string;
  label: string;
  share: number;
  failed: number;
}

function failedShare(
  columnShare: number,
  failedCostUsd: number,
  costUsd: number
): number {
  if (columnShare <= 0 || failedCostUsd <= 0 || costUsd <= 0) return 0;
  return Math.min(
    columnShare,
    Math.max(1, Math.round((failedCostUsd / costUsd) * columnShare))
  );
}

export interface InsightColumnOptions {
  windowDays: number;
  columns: number;
  now: number;
}

export function insightColumns(
  rollup: InsightRollup,
  options: InsightColumnOptions,
  words: InsightWords
): InsightColumn[] {
  const fold = {
    anchor: rollup.generatedAt > 0 ? rollup.generatedAt : options.now,
    columns: options.columns,
    windowDays: options.windowDays,
  };
  const buckets = dayFold(rollup.daily, fold);
  const failedBuckets = dayFold(
    rollup.daily.map((day) => ({
      costUsd: day.failedCostUsd,
      date: day.date,
      runs: day.failedRuns,
    })),
    fold
  );
  const shares = barShares(buckets.map((bucket) => bucket.costUsd));
  return buckets.map((bucket, index) => {
    const span =
      bucket.date === bucket.endDate
        ? dayMark(bucket.date)
        : `${dayMark(bucket.date)} – ${dayMark(bucket.endDate)}`;
    const failedRuns = failedBuckets[index]?.runs ?? 0;
    const share = shares[index] ?? 0;
    return {
      failed: failedShare(
        share,
        failedBuckets[index]?.costUsd ?? 0,
        bucket.costUsd
      ),
      key: bucket.key,
      label: [
        span,
        words.cost(bucket.costUsd),
        insightRunWord(bucket.runs),
        ...(failedRuns > 0 ? [`${String(failedRuns)} failed`] : []),
      ].join(" · "),
      share,
    };
  });
}

export function insightAxisMarks(
  rollup: InsightRollup,
  windowDays: number,
  now: number
): string[] {
  const days = dayFold([], {
    anchor: rollup.generatedAt > 0 ? rollup.generatedAt : now,
    columns: windowDays,
    windowDays,
  });
  const first = days[0];
  if (!first) return [];
  const middle = days[Math.floor(days.length / 2)];
  const marks = [dayMark(first.date)];
  if (middle && days.length > 2) marks.push(dayMark(middle.date));
  marks.push("today");
  return marks;
}

export function insightPeakNote(
  rollup: InsightRollup,
  words: InsightWords
): string | undefined {
  const peak = rollup.peakDay;
  if (!peak) return undefined;
  const top = peak.topSources[0];
  return [
    `Busiest ${dayMark(peak.date)}: ${words.cost(peak.costUsd)}`,
    `${words.count(peak.tokens)} tokens`,
    ...(top ? [`mostly ${top.label}`] : []),
  ].join(" · ");
}

export function insightPricingLine(
  rollup: InsightRollup,
  words: InsightWords
): string {
  const { kpis } = rollup;
  const parts: string[] = [];
  if (kpis.harnessReportedCostUsd > 0)
    parts.push(`${words.cost(kpis.harnessReportedCostUsd)} harness-reported`);
  if (kpis.estimatedCostUsd > 0)
    parts.push(`${words.cost(kpis.estimatedCostUsd)} estimated`);
  if (kpis.unpricedRuns > 0)
    parts.push(`${String(kpis.unpricedRuns)} unpriced`);
  if (kpis.unreportedRuns > 0)
    parts.push(`${String(kpis.unreportedRuns)} no usage reported`);
  if (parts.length === 0)
    return kpis.generations === 0
      ? "No completed runs in this window."
      : "All priced runs included.";
  return `${parts.join(" · ")}.`;
}

export function insightSpendFigure(
  rollup: InsightRollup,
  windowDays: number,
  words: InsightWords
): PanelFigureData {
  const { kpis } = rollup;
  const incomplete = kpis.unpricedRuns > 0 || kpis.unreportedRuns > 0;
  return {
    label: `${incomplete ? "At least" : "Spend"} · ${String(windowDays)} days`,
    qualifier: insightPricingLine(rollup, words),
    value: words.cost(kpis.totalCostUsd),
  };
}

export function insightSpendFacts(
  rollup: InsightRollup,
  words: InsightWords
): PanelFactData[] {
  const { kpis } = rollup;
  const facts: PanelFactData[] = [
    {
      key: "runs",
      value:
        kpis.retries > 0
          ? `${kpis.generations.toLocaleString()} · ${String(kpis.retries)} retried`
          : kpis.generations.toLocaleString(),
    },
    {
      key: "tokens",
      value:
        kpis.hydrationTokens > 0
          ? `${words.count(kpis.totalTokens)} · ${words.count(kpis.hydrationTokens)} hydration`
          : words.count(kpis.totalTokens),
    },
    {
      key: "forecast",
      note: words.forecastNote,
      value: words.cost(kpis.forecastCostUsd),
    },
  ];
  if (kpis.medianRunMs !== undefined)
    facts.push({ key: "typical run", value: words.duration(kpis.medianRunMs) });
  if (kpis.failedRuns > 0)
    facts.push({
      key: "failed",
      net: true,
      value: `${String(kpis.failedRuns)} · ${words.cost(kpis.failedCostUsd)} spent`,
    });
  if (rollup.attention)
    facts.push({
      key: "most of it",
      value: `${rollup.attention.label} · ${String(Math.round(rollup.attention.share * 100))}% of spend`,
    });
  return facts;
}

export function insightSourceFacts(
  rollup: InsightRollup,
  words: InsightWords
): PanelFactData[] {
  return insightSourceRollups(rollup.bySource).map((row) => ({
    key: row.bucket,
    value: `${String(row.runs)} · ${row.sharePercent === null ? "—" : `${String(row.sharePercent)}%`} · ${words.cost(row.costUsd)}`,
  }));
}

export interface InsightBreakdowns {
  source: InsightBreakdown;
  harness: InsightBreakdown;
  model: InsightBreakdown;
  effort: InsightBreakdown;
}

export function insightBreakdowns(
  rollup: InsightRollup,
  words: InsightWords
): InsightBreakdowns {
  const word = (items: readonly InsightMeasuredDatum[]): InsightBreakdown =>
    insightBreakdown(items, words.cost, words.count, insightRunWord);
  return {
    effort: word(
      rollup.byEffort.map((row) => ({
        ...row,
        id: row.effort,
        label: row.effort,
      }))
    ),
    harness: word(
      rollup.byHarness.map((row) => ({
        ...row,
        id: row.harness,
        label: row.harness,
      }))
    ),
    model: word(
      rollup.byModel.map((row) => ({ ...row, id: row.model, label: row.model }))
    ),
    source: word(
      rollup.bySource.map((row) => ({ ...row, id: `${row.kind}:${row.key}` }))
    ),
  };
}

const CSV_HEADER = "date,runs,failed_runs,tokens,cost_usd,failed_cost_usd";

export function insightRollupCsv(rollup: InsightRollup): string {
  const rows = rollup.daily.map((day) =>
    [
      day.date,
      String(day.runs),
      String(day.failedRuns),
      String(day.tokens),
      day.costUsd.toFixed(4),
      day.failedCostUsd.toFixed(4),
    ].join(",")
  );
  return [CSV_HEADER, ...rows].join("\n");
}

export function insightCsvFilename(windowDays: number): string {
  return `centraid-analytics-${String(windowDays)}d.csv`;
}
