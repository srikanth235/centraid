import { justify } from "./justify";
import type { JustifiedTile } from "./justify";
import type { PhotoAsset, PhotoSection } from "./timeline-model";

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

export const MONTH_ROW_HEIGHT = 46;
export const DAY_ROW_HEIGHT = 34;
export const ROW_GAP = 2;

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

export function monthHeaderIndices(rows: readonly TimelineRow[]): number[] {
  return rows.flatMap((row, index) => (row.type === "month" ? [index] : []));
}

export function rowTops(rows: readonly TimelineRow[]): number[] {
  const tops: number[] = [];
  let cursor = 0;
  for (const row of rows) {
    tops.push(cursor);
    cursor += row.height;
  }
  return tops;
}

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

function dayOfRow(row: TimelineRow | undefined): string | undefined {
  if (row?.type === "day") return row.key.slice(2);
  if (row?.type === "assets") return row.key.split(":")[1];
  return undefined;
}

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
