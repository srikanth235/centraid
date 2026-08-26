// THE LIBRARY'S TEMPORAL GRAIN — Years · Months · All (#712 iOS parity).
//
// Sections in, period cards out. The grain is a VIEW, NOT A FILTER: Years and
// Months summarise, and every card is a door back into All positioned at that
// period — hence periods carry the `PhotoSection.day` of their first section,
// so the three grains cannot disagree about where a period starts.
//
// GROUP OFF `section.month`, NEVER A SECOND PARSE OF `capturedAt`.
// `sectionPhotoAssets` already resolved each capture into its own wall clock
// (`captureLocalDay`); re-parsing the instant files a 20:00-local photograph in
// the wrong month, and every December 31st in the wrong YEAR.
//
// COVER = NEWEST, never a ranking: this vault has none of the signals iOS picks
// a key photo from, and a card must land on the photograph at the top of that
// period in All.
//
// UNDATED PHOTOGRAPHS ARE EXCLUDED here though visible in All: a period card
// means "a stretch of time", and "sometime" is not one.
//
// REVERSE ANCHORING: a period's key is a PREFIX of every day it contains, so
// the period containing a day is found by slicing the day to the key's width.
// One rule, so Years→Months, Months→Years, Months→All and All→Months cannot
// drift apart.

import { UNDATED_SECTION_DAY } from "./timeline-model";
import type { PhotoAsset, PhotoSection } from "./timeline-model";
import { describeCounts } from "./timeline-rows";

/** Widest first — the control's own left-to-right order. */
export type TimelineGrain = "years" | "months" | "all";

/** `all` is the timeline itself, so it has no periods to build. */
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
  /** `2026` or `2026-08`, and ALWAYS a prefix of every `PhotoSection.day` in
   *  the period — reverse anchoring depends on exactly that. */
  key: string;
  /** Taken from the section's own `monthTitle`, never a formatter re-run here,
   *  so a month is named identically in both views. */
  title: string;
  /** `describeCounts` wording, so a count means one thing across all grains. */
  count: string;
  cover: PhotoAsset | undefined;
  /** What All is told to scroll to, and what the next grain down anchors on. */
  anchorDay: string;
  /** For the Months view's year headers; equals `key` at the year grain. */
  year: string;
}

/**
 * PRESERVES the sections' newest-first order; never re-sort. A re-sort makes
 * the period view a different library from All, and disagrees with the caller's
 * filter, which may hand over any subsequence.
 *
 * Periods come only from sections that exist, so a year with no photographs
 * produces no card rather than an empty one promising photographs.
 */
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

/** The reverse of a card's `anchorDay`. `undefined` when there is nothing to
 *  anchor on — no day yet, or the Undated section, which holds no calendar
 *  position; the caller then leaves the target grain at its top. */
export function periodContaining(
  periods: readonly GrainPeriod[],
  day: string | undefined
): GrainPeriod | undefined {
  if (day === undefined || day === UNDATED_SECTION_DAY) return undefined;
  return periods.find(
    (period) => day.slice(0, period.key.length) === period.key
  );
}

/** The one entry point a screen needs on a grain switch. At a summary grain it
 *  returns the containing period's own `anchorDay`, so bouncing
 *  Years↔Months↔All cannot drift. */
export function anchorForGrain(
  sections: readonly PhotoSection[],
  grain: TimelineGrain,
  day: string | undefined
): string | undefined {
  if (day === undefined || day === UNDATED_SECTION_DAY) return undefined;
  if (grain === "all") return day;
  return periodContaining(buildPeriods(sections, grain), day)?.anchorDay;
}
