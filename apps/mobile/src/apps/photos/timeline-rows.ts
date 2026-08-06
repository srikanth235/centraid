// The timeline's row list: month headers, day sub-labels, and justified asset
// rows (Photos v4 handoff §4.1, §4.3).
//
// Pure, and separate from the component, because this is where the grouping
// rules and the packing meet — and both are things to assert rather than to
// eyeball. The component below it only maps rows to views.

import { justify } from "./justify";
import type { JustifiedTile } from "./justify";
import type { PhotoAsset, PhotoSection } from "./timeline-model";

export type TimelineRow =
  | {
      type: "month";
      key: string;
      title: string;
      /** The mono count beside the month label, already worded. */
      count: string;
      height: number;
    }
  | {
      type: "day";
      key: string;
      title: string;
      /** Mono count, plus an optional place: `12 · Lyme Regis`. */
      count: string;
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

/** `12` or `12 · Lyme Regis` — the day's count, and the place when one is
 *  known for the whole day. A place that varies through the day is not the
 *  day's place, so it is left off rather than guessed at. */
export function describeDay(
  assets: readonly PhotoAsset[],
  placeNames: ReadonlyMap<string, string>
): string {
  const places = new Set(
    assets.flatMap((asset) => (asset.placeId ? [asset.placeId] : []))
  );
  const only = places.size === 1 ? [...places][0] : undefined;
  const place = only ? placeNames.get(only) : undefined;
  return place ? `${assets.length} · ${place}` : String(assets.length);
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
  // Month counts span every day in the month, so they are accumulated first —
  // the header states what the month holds, not what its first day holds.
  const byMonth = new Map<string, PhotoAsset[]>();
  for (const section of sections) {
    byMonth.set(section.month, [
      ...(byMonth.get(section.month) ?? []),
      ...section.assets,
    ]);
  }

  let previousMonth: string | undefined;
  for (const section of sections) {
    if (section.month !== previousMonth) {
      previousMonth = section.month;
      rows.push({
        type: "month",
        key: `m:${section.month}`,
        title: section.monthTitle,
        count: describeCounts(byMonth.get(section.month) ?? []),
        height: MONTH_ROW_HEIGHT,
      });
    }
    rows.push({
      type: "day",
      key: `d:${section.day}`,
      title: section.title,
      count: describeDay(section.assets, placeNames),
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
