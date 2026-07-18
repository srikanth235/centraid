// The lightbox info panel's "Activity" list (reference mockup's receipted
// timeline). Honest about what this vault can actually surface: there is no
// per-event history query (no "when was this added to that album" fact),
// only the asset's own capture date — so, exactly like the reference mockup
// itself (whose activity rows all read `lf.taken`, never a distinct per-event
// timestamp), every row here shares that one real date signal instead of
// inventing per-fact ones. Each fact still corresponds to a real receipted
// vault command when it happened (add_to_album/tag_item/add_asset are all
// typed, consent-checked commands) — this module just doesn't claim to know
// exactly when.
import { dayKey, fmtDay } from './format.ts';
import type { ActivityItem, Asset } from './types.ts';

export function buildActivity(asset: Asset): ActivityItem[] {
  const dateLabel = fmtDay(dayKey(asset.taken_at ?? asset.captured_at));
  const activity: ActivityItem[] = [];
  const albumTitles = asset.album_titles ?? [];
  if (albumTitles.length > 0) {
    activity.push({
      text: `Added to ${albumTitles.map((t) => `“${t}”`).join(', ')}`,
      date: dateLabel,
    });
  }
  const tags = asset.tags ?? [];
  if (tags.length > 0) {
    activity.push({ text: `Tagged ${tags.map((t) => t.label).join(', ')}`, date: dateLabel });
  }
  activity.push({ text: 'Uploaded to your vault', date: dateLabel });
  return activity;
}
