// The timeline's row list: month headers, day sub-labels, and justified asset
// rows (Photos v4 handoff §4.1, §4.3).
//
// Pure, and separate from the component, because this is where the grouping
// rules and the packing meet — and both are things to assert rather than to
// eyeball. The component below it only maps rows to views.

import { justify } from "./justify";
import type { JustifiedTile } from "./justify";
import type { PhotoAsset, PhotoSection } from "./timeline-model";

// NO COUNTS ON THE TIMELINE (issue 712 iOS parity). The month and day headers
// used to carry `86 photographs · 4 videos` and a bare `12`. They are gone:
// iOS' own Library states neither, and the reason holds here — the tally of a
// month is not what a member scrolls a timeline to find out, and printing it
// on every header puts a number in the reading path of every single row. The
// counts still exist where a count IS the question: the period cards of the
// Years and Months grains (`photos-zoom.ts`, which still calls
// `describeCounts` below) summarise a period the member cannot see the whole
// of, and the Collections shelves state their own sizes.
//
// The day's PLACE survives, because it is not a tally — it says where you
// were, which is the one thing about a day a row of thumbnails cannot show.
export type TimelineRow =
  | {
      type: "month";
      key: string;
      title: string;
      height: number;
    }
  | {
      type: "day";
      key: string;
      title: string;
      /** The day's place, when one is known for the whole day — `Lyme Regis`,
       *  or empty. Never a count; see above. */
      place: string;
      assets: PhotoAsset[];
      height: number;
    }
  | {
      type: "assets";
      key: string;
      tiles: JustifiedTile[];
      height: number;
    };

/** Sticky month header. Micro-caps label, mono count, persists while its month
 *  is on screen. */
export const MONTH_ROW_HEIGHT = 46;
/** Day sub-label. */
export const DAY_ROW_HEIGHT = 34;
/** Vertical gutter between packed rows — 2px, the same as the horizontal one. */
export const ROW_GAP = 2;

/**
 * `86 photographs · 4 videos`. Videos are named only when there are some;
 * a count of zero is not information, it is chrome.
 */
export function describeCounts(assets: readonly PhotoAsset[]): string {
  const videos = assets.filter((asset) => asset.kind === "video").length;
  const photographs = assets.length - videos;
  const parts: string[] = [];
  if (photographs > 0) {
    parts.push(`${photographs} photograph${photographs === 1 ? "" : "s"}`);
  }
  if (videos > 0) parts.push(`${videos} video${videos === 1 ? "" : "s"}`);
  return parts.join(" · ") || "0 photographs";
}

/** The day's place — `Lyme Regis`, or empty when there is not one. A place
 *  that varies through the day is not the day's place, so it is left off
 *  rather than guessed at, and an unknown place prints nothing rather than a
 *  hedge. */
export function dayPlace(
  assets: readonly PhotoAsset[],
  placeNames: ReadonlyMap<string, string>
): string {
  const places = new Set(
    assets.flatMap((asset) => (asset.placeId ? [asset.placeId] : []))
  );
  const only = places.size === 1 ? [...places][0] : undefined;
  return (only ? placeNames.get(only) : undefined) ?? "";
}

/**
 * Builds the flat row list a virtualised list consumes. Month headers are
 * emitted once per month (not per day), so the sticky header is the month the
 * member is actually scrolling through.
 */
export function buildRows(
  sections: readonly PhotoSection[],
  containerWidth: number,
  targetHeight: number,
  placeNames: ReadonlyMap<string, string> = new Map()
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let previousMonth: string | undefined;
  for (const section of sections) {
    if (section.month !== previousMonth) {
      previousMonth = section.month;
      rows.push({
        type: "month",
        key: `m:${section.month}`,
        title: section.monthTitle,
        height: MONTH_ROW_HEIGHT,
      });
    }
    rows.push({
      type: "day",
      key: `d:${section.day}`,
      title: section.title,
      place: dayPlace(section.assets, placeNames),
      assets: section.assets,
      height: DAY_ROW_HEIGHT,
    });
    const packed = justify(section.assets, containerWidth, targetHeight);
    packed.forEach((tiles, index) => {
      rows.push({
        type: "assets",
        key: `r:${section.day}:${index}:${targetHeight}`,
        tiles,
        height: (tiles[0]?.height ?? targetHeight) + ROW_GAP,
      });
    });
  }
  return rows;
}

/** Indices of the sticky month headers, for the list's `stickyHeaderIndices`. */
export function monthHeaderIndices(rows: readonly TimelineRow[]): number[] {
  return rows.flatMap((row, index) => (row.type === "month" ? [index] : []));
}

/** Prefix-summed row tops, so a scrub or a drag maps an offset to a row by
 *  binary search instead of re-walking every height. */
export function rowTops(rows: readonly TimelineRow[]): number[] {
  const tops: number[] = [];
  let cursor = 0;
  for (const row of rows) {
    tops.push(cursor);
    cursor += row.height;
  }
  return tops;
}

/**
 * The `PhotoSection.day` at a scroll offset — where the member currently IS.
 *
 * The grain control needs an answer to "which day is on screen" to keep a
 * member's place when they switch to Years or Months (`timeline-grains.ts`), and
 * the answer has to be in the same vocabulary a period card speaks: a section
 * day, never a row index or a pixel. Day and asset rows both carry the day in
 * their key (`d:2026-08-06`, `r:2026-08-06:0:112`), so the walk back from the
 * row at the offset finds it without a second pass over the sections.
 *
 * Month headers carry no day of their own, so the walk steps off them: back
 * first, to the day the member has already scrolled past — a sticky header is
 * on screen for its whole month, and answering from it would report the first
 * day of the month however far into it the member had scrolled — and forward
 * only when there is nothing behind, which happens exactly once, at the very
 * top of the list where the first row IS a month header.
 */
export function dayAtOffset(
  rows: readonly TimelineRow[],
  tops: readonly number[],
  offset: number
): string | undefined {
  let lo = 0;
  let hi = rows.length - 1;
  let at = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tops[mid]! <= offset) {
      at = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const start = Math.min(at, rows.length - 1);
  for (let cursor = start; cursor >= 0; cursor -= 1) {
    const day = dayOfRow(rows[cursor]);
    if (day !== undefined) return day;
  }
  for (let cursor = start + 1; cursor < rows.length; cursor += 1) {
    const day = dayOfRow(rows[cursor]);
    if (day !== undefined) return day;
  }
  return undefined;
}

/** The section day a row belongs to, read off its own key — `d:2026-08-06`
 *  and `r:2026-08-06:0:112` both carry it, a month header does not. */
function dayOfRow(row: TimelineRow | undefined): string | undefined {
  if (row?.type === "day") return row.key.slice(2);
  if (row?.type === "assets") return row.key.split(":")[1];
  return undefined;
}

/** The month a row belongs to, for the scrub rail's bubble. */
export function monthLabelAt(
  rows: readonly TimelineRow[],
  index: number
): string {
  for (
    let cursor = Math.min(index, rows.length - 1);
    cursor >= 0;
    cursor -= 1
  ) {
    const row = rows[cursor];
    if (row?.type === "month") return row.title;
  }
  const first = rows.find((row) => row.type === "month");
  return first?.type === "month" ? first.title : "";
}
