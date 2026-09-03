import { plural } from "../_shared/format-kit.ts";
import { dayKey, fmtMonth, isVideoAsset } from "./format.ts";
import { readableName } from "./place-map.ts";
import type { Asset } from "./types.ts";

export interface DayGroup {
  key: string;
  assets: Asset[];
  meta: string;
}

export interface MonthGroup {
  key: string;
  label: string;
  count: string;
  days: DayGroup[];
  assets: Asset[];
}

export function monthCount(assets: readonly Asset[]): string {
  const videos = assets.filter((asset) => isVideoAsset(asset)).length;
  const photographs = assets.length - videos;
  const head = plural(photographs, "photograph");
  return videos === 0 ? head : `${head} · ${plural(videos, "video")}`;
}

export function dayMeta(assets: readonly Asset[]): string {
  const count = String(assets.length);
  const names = new Set(
    assets.flatMap((asset) => {
      const name = readableName(asset.place?.name);
      return name === null ? [] : [name];
    })
  );
  const named = assets.every(
    (asset) => readableName(asset.place?.name) !== null
  );
  return names.size === 1 && named ? `${count} · ${[...names][0]}` : count;
}

export function groupByMonth(assets: readonly Asset[]): MonthGroup[] {
  const months = new Map<string, Map<string, Asset[]>>();
  for (const asset of assets) {
    const dk = dayKey(asset.taken_at);
    const mk = dk.slice(0, 7);
    let days = months.get(mk);
    if (!days) {
      days = new Map();
      months.set(mk, days);
    }
    const bucket = days.get(dk);
    if (bucket) bucket.push(asset);
    else days.set(dk, [asset]);
  }
  return [...months].map(([key, days]) => {
    const flat = [...days.values()].flat();
    return {
      key,
      label: fmtMonth(key),
      count: monthCount(flat),
      assets: flat,
      days: [...days].map(([dk, dayAssets]) => ({
        key: dk,
        assets: dayAssets,
        meta: dayMeta(dayAssets),
      })),
    };
  });
}

export interface MonthTick {
  key: string;
  short: string;
}

export function monthTicks(months: readonly MonthGroup[]): MonthTick[] {
  return months.map((month) => ({ key: month.key, short: shortMonth(month) }));
}

function shortMonth(month: MonthGroup): string {
  if (!month.key) return "Undated";
  try {
    return new Date(`${month.key}-01T00:00:00`).toLocaleDateString(undefined, {
      month: "short",
      year: "numeric",
    });
  } catch {
    return month.key;
  }
}
