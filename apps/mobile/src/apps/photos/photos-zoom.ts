// The Library's TEMPORAL ZOOM — Years / Months / All (issue #712 iOS parity).
//
// iOS Photos' Library is not one grid, it is three views of the same ledger at
// three grains, with a floating drawer to move between them. That drawer is the
// only navigation a member has to a photograph taken years ago that is not
// search: the alternative is dragging a scrub rail through ten thousand rows
// hoping the month bubble stops on the right one. We already had the rail
// (`ScrubRail.tsx`); what was missing is the grain.
//
// THE GRAIN IS A VIEW, NOT A FILTER. Years and Months do not hide photographs —
// they summarise periods, and every card is a door back into All positioned at
// that period. So this module returns PERIODS, each carrying the `day` key of
// its first section: that key is how the All grid is asked where to land, and
// it is the same key `PhotoSection.day` already uses, so the two views cannot
// disagree about where a period starts.
//
// COVER = NEWEST. iOS picks a "key photo" per period using signals this vault
// does not have (faces, scene scores, curation). Rather than invent a ranking
// we cannot explain, the cover is simply the period's newest photograph — the
// one at the top of that period in All. A member who taps the card lands on the
// photograph they were just looking at, which is a weaker claim than iOS makes
// and a true one.
//
// Pure, and separate from the views, because the grouping is the part worth
// asserting; `PhotoPeriodGrid.tsx` only maps periods to cards.

import type { PhotoAsset, PhotoSection } from "./timeline-model";
import { describeCounts } from "./timeline-rows";

/** The three grains, in the drawer's own left-to-right order — widest first,
 *  the same direction iOS reads. */
export type TimelineZoom = "years" | "months" | "all";

export const ZOOM_LEVELS: readonly TimelineZoom[] = ["years", "months", "all"];

export const ZOOM_LABELS: Record<TimelineZoom, string> = {
  all: "All",
  months: "Months",
  years: "Years",
};

/** One card in the Years or Months grid. */
export interface PeriodGroup {
  /** `2026` at the year grain, `2026-08` at the month grain. */
  key: string;
  /** `2026` or `August 2026` — the year grain has no formatter to run, and the
   *  month grain reuses the title the sections already carry. */
  title: string;
  /** The same `86 photographs · 4 videos` wording the month header uses, so a
   *  count means one thing across all three grains. */
  count: string;
  /** The period's newest photograph — see the header for why not a ranking. */
  cover: PhotoAsset | undefined;
  /** `PhotoSection.day` of this period's first section: what All is told to
   *  scroll to when the card is tapped. */
  anchorDay: string;
  /** The year this period sits under, for the Months grid's sticky headers.
   *  At the year grain it equals `key`. */
  year: string;
}

/**
 * Groups already-sectioned days into periods at one grain.
 *
 * Sections arrive newest-first (`sectionPhotoAssets` preserves
 * `mergePhotoAssets`' order), and this preserves that order rather than
 * re-sorting: a period grid that ran oldest-first while All ran newest-first
 * would be two different libraries wearing the same title.
 */
export function buildPeriods(
  sections: readonly PhotoSection[],
  grain: "years" | "months"
): PeriodGroup[] {
  const order: string[] = [];
  const bySections = new Map<string, PhotoSection[]>();
  for (const section of sections) {
    // `section.month` is the `YYYY-MM` slice of the capture-local day, so the
    // year slice below is that same reference — never a second parse of
    // `capturedAt`, which would put a 20:00-local photograph in the wrong year
    // exactly as often as it put it in the wrong day.
    const key = grain === "years" ? section.month.slice(0, 4) : section.month;
    const bucket = bySections.get(key);
    if (bucket) bucket.push(section);
    else {
      order.push(key);
      bySections.set(key, [section]);
    }
  }
  return order.map((key) => {
    const group = bySections.get(key)!;
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

/**
 * The grain one step narrower — what tapping a card means.
 *
 * A Years card opens Months, a Months card opens All, and All has nothing
 * below it, so its own cards (there are none) cannot drill further. Returned
 * rather than branched at the call site so the two grids share one rule.
 */
export function drillInto(grain: TimelineZoom): TimelineZoom {
  return grain === "years" ? "months" : "all";
}
