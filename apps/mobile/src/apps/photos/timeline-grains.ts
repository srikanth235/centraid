import { UNDATED_SECTION_DAY } from "./timeline-model";
import type { PhotoAsset, PhotoSection } from "./timeline-model";
import { describeCounts } from "./timeline-rows";

export type TimelineGrain = "years" | "months" | "all";

export type SummaryGrain = "years" | "months";

export const TIMELINE_GRAINS: readonly TimelineGrain[] = [
  "years",
  "months",
  "all",
];

export const GRAIN_LABELS: Record<TimelineGrain, string> = {
  all: "All",
  months: "Months",
  years: "Years",
};

export interface GrainPeriod {
  key: string;
  title: string;
  count: string;
  cover: PhotoAsset | undefined;
  anchorDay: string;
  year: string;
}

export function buildPeriods(
  sections: readonly PhotoSection[],
  grain: SummaryGrain
): GrainPeriod[] {
  const order: string[] = [];
  const grouped = new Map<string, PhotoSection[]>();
  for (const section of sections) {
    if (section.day === UNDATED_SECTION_DAY) continue;
    const key = grain === "years" ? section.month.slice(0, 4) : section.month;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(section);
    else {
      order.push(key);
      grouped.set(key, [section]);
    }
  }
  return order.map((key) => {
    const group = grouped.get(key)!;
    const assets = group.flatMap((section) => section.assets);
    return {
      anchorDay: group[0]!.day,
      count: describeCounts(assets),
      cover: assets[0],
      key,
      title: grain === "years" ? key : group[0]!.monthTitle,
      year: key.slice(0, 4),
    };
  });
}

export function periodContaining(
  periods: readonly GrainPeriod[],
  day: string | undefined
): GrainPeriod | undefined {
  if (day === undefined || day === UNDATED_SECTION_DAY) return undefined;
  return periods.find(
    (period) => day.slice(0, period.key.length) === period.key
  );
}

export function anchorForGrain(
  sections: readonly PhotoSection[],
  grain: TimelineGrain,
  day: string | undefined
): string | undefined {
  if (day === undefined || day === UNDATED_SECTION_DAY) return undefined;
  if (grain === "all") return day;
  return periodContaining(buildPeriods(sections, grain), day)?.anchorDay;
}
