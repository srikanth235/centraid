// THE LIBRARY'S TEMPORAL GRAIN — Years · Months · All (issue #712 iOS parity).
//
// iOS Photos' Library is not one grid, it is three views of the same ledger at
// three grains. This module is the grouping half of that: sections in, period
// cards out. The views (`PhotoGrainView.tsx`) only map periods to cards, and
// the control (`TimelineGrainControl.tsx`) only moves between grains — the
// grouping is the part worth asserting, so it lives here where a test needs no
// renderer to reach it.
//
// THE GRAIN IS A VIEW, NOT A FILTER. Years and Months do not hide photographs;
// they summarise periods, and every card is a door back into All positioned at
// that period. So this module returns PERIODS, each carrying the `day` key of
// its first section. That key is what the All grid is asked to scroll to, and
// it is the same `PhotoSection.day` the sections already carry, so the three
// grains cannot disagree about where a period starts.
//
// GROUPING IS OFF `section.month`, NEVER A SECOND PARSE OF `capturedAt`. The
// sections were built by `sectionPhotoAssets`, which resolved each capture into
// its own wall clock (`captureLocalDay`) before slicing the day. Re-parsing the
// instant here would file a 20:00-local photograph in the wrong month — and,
// every December 31st, in the wrong YEAR — exactly as often as the old day
// bucketing put it on the wrong day. `section.month` is already that resolved
// answer; the year is its first four characters.
//
// COVER = NEWEST. iOS picks a "key photo" per period from signals this vault
// does not have (faces, scene scores, curation history). Rather than invent a
// ranking we cannot explain, the cover is the period's newest photograph — the
// one at the top of that period in All. A member who taps the card lands on the
// photograph they were just looking at: a weaker claim than iOS makes, and a
// true one.
//
// UNDATED PHOTOGRAPHS HOLD NO POSITION IN DATE NAVIGATION. `PhotoAsset`'s
// `capturedAt` is optional (the device media store records neither a creation
// nor a modification time for some rows), and `sectionPhotoAssets` collects
// those into one `UNDATED_SECTION_DAY` section sorted last. That section is
// visible in All — the photographs exist and a member must be able to reach
// them — but it is excluded here, because a period card means "a stretch of
// time" and "sometime" is not one. Giving it a card would either fabricate a
// year or add a card to the Years grid that answers a different question from
// every other card beside it.
//
// REVERSE ANCHORING IS THE POINT OF `periodContaining`. Drilling DOWN a grain
// is easy: the card knows its own anchor day. Keeping the member's place when
// they switch grains from a persistent control is the harder half, and it is
// the half the previous implementation never had — a member who scrolled Months
// back to 2019 and tapped Years landed at the top of the library. Both
// directions run through one rule here: a period's key is a PREFIX of every day
// it contains (`2026` of `2026-03-15`, `2026-03` of `2026-03-15`), so the
// period containing a day is found by slicing the day to the key's own width.
// One rule, so Years→Months, Months→Years, Months→All and All→Months cannot
// drift apart.

import { UNDATED_SECTION_DAY } from "./timeline-model";
import type { PhotoAsset, PhotoSection } from "./timeline-model";
import { describeCounts } from "./timeline-rows";

/** The three grains, widest first — the control's own left-to-right order, and
 *  the direction iOS reads. */
export type TimelineGrain = "years" | "months" | "all";

/** The two grains that summarise. `all` is the timeline itself, not a summary,
 *  so it has no periods to build. */
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

/** One card in the Years or Months view. */
export interface GrainPeriod {
  /** `2026` at the year grain, `2026-08` at the month grain. Always a prefix of
   *  every `PhotoSection.day` inside the period — see the header on reverse
   *  anchoring, which depends on exactly that. */
  key: string;
  /** `2026`, or `August 2026` taken from the section's own `monthTitle` — never
   *  a formatter re-run here, so a month is named identically in both views. */
  title: string;
  /** The same `86 photographs · 4 videos` wording every count in the app uses
   *  (`describeCounts`), so a count means one thing across all three grains. */
  count: string;
  /** The period's newest photograph — see the header for why not a ranking. */
  cover: PhotoAsset | undefined;
  /** `PhotoSection.day` of this period's first section: what All is told to
   *  scroll to, and what the next grain down anchors on. */
  anchorDay: string;
  /** The year this period sits under, for the Months view's year headers. At
   *  the year grain it equals `key`. */
  year: string;
}

/**
 * Groups already-sectioned days into periods at one summary grain.
 *
 * Sections arrive newest-first (`sectionPhotoAssets` preserves
 * `mergePhotoAssets`' order) and this PRESERVES that order rather than
 * re-sorting. A period view running oldest-first while All ran newest-first
 * would be two different libraries wearing the same title — and a re-sort here
 * would also quietly disagree with the caller's own filter, which is allowed to
 * hand over any subsequence it likes.
 *
 * Periods come from the sections that exist, so a year with no photographs
 * produces no card. That is not a special case to code; it is the absence of
 * one, and it is why a library with a missing year shows a gap rather than an
 * empty card promising photographs that are not there.
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

/**
 * The period that contains a day — the reverse of a card's `anchorDay`.
 *
 * This is what keeps a member's place when they change grain from the
 * persistent control rather than by tapping a card. `day` is whatever the grain
 * they are leaving is currently showing: a real `PhotoSection.day` from All, or
 * the `anchorDay` of the period they were looking at in Years or Months.
 *
 * `undefined` when there is nothing to anchor on — no day yet (they have not
 * moved), or the Undated section, which by design has no position in the
 * calendar to carry across (see the header). The caller then leaves the target
 * grain where it naturally starts: the top, newest first.
 */
export function periodContaining(
  periods: readonly GrainPeriod[],
  day: string | undefined
): GrainPeriod | undefined {
  if (day === undefined || day === UNDATED_SECTION_DAY) return undefined;
  return periods.find(
    (period) => day.slice(0, period.key.length) === period.key
  );
}

/**
 * The day a grain should be positioned at, given where the member is now.
 *
 * The one entry point a screen needs on a grain switch: hand it the day
 * currently on screen and the grain being switched to, get back the day to hand
 * that grain. At `all` it is the day itself — the timeline can land on any day.
 * At a summary grain it is the containing period's own anchor day, so that the
 * period the member lands on and the period All would open from that card are
 * the SAME day, and a member can bounce Years↔Months↔All without drifting.
 */
export function anchorForGrain(
  sections: readonly PhotoSection[],
  grain: TimelineGrain,
  day: string | undefined
): string | undefined {
  if (day === undefined || day === UNDATED_SECTION_DAY) return undefined;
  if (grain === "all") return day;
  return periodContaining(buildPeriods(sections, grain), day)?.anchorDay;
}
