import { dayKey, fmtDay } from "./format.ts";
import type { ActivityItem, Asset } from "./types.ts";

export function buildActivity(asset: Asset): ActivityItem[] {
  const dateLabel = fmtDay(dayKey(asset.taken_at ?? asset.captured_at));
  const activity: ActivityItem[] = [];
  const albumTitles = asset.album_titles ?? [];
  if (albumTitles.length > 0) {
    activity.push({
      text: `Added to ${albumTitles.map((t) => `“${t}”`).join(", ")}`,
      date: dateLabel,
    });
  }
  const tags = asset.tags ?? [];
  if (tags.length > 0) {
    activity.push({
      text: `Tagged ${tags.map((t) => t.label).join(", ")}`,
      date: dateLabel,
    });
  }
  activity.push({ text: "Uploaded to your library", date: dateLabel });
  return activity;
}
