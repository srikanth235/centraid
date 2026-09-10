// THE TWO AMBIENT EFFECTS PHOTOS' HOME RUNS (#1015 Wave 2).
//
// Neither draws anything, and neither belongs in a render tree that is now the
// room's: one keeps the pinned thumbnail pack in step with the timeline, the
// other schedules the once-a-day "on this day" notice. They live here so
// `PhotosHome.tsx` reads as wiring rather than as a pile of effects.

import * as Notifications from "expo-notifications";
import { useEffect, useRef } from "react";

import { refreshPinnedThumbnailPack } from "../../lib/replica/thumbnail-pack";
import { Store } from "../../storage";
import {
  pinnedThumbnailCandidates,
  pinnedThumbnailSignature,
} from "./pinned-thumbnails";
import type { PhotoAsset } from "./timeline-source";

/**
 * Keep the pinned thumbnail pack in step with the timeline.
 *
 * The pack refresh stats every pinned file, so it must not ride every timeline
 * snapshot — the engine republishes on each replica tick with the candidate
 * set almost always unchanged. Hence the signature gate.
 */
export function usePinnedThumbnailPack(
  gatewayBase: string | undefined,
  assets: readonly PhotoAsset[]
): void {
  const packSignature = useRef<string | undefined>(undefined);
  const packRun = useRef<Promise<void> | undefined>(undefined);
  useEffect(() => {
    if (!gatewayBase) return;
    const signature = pinnedThumbnailSignature(gatewayBase, assets);
    if (signature === packSignature.current) return;
    packSignature.current = signature;
    packRun.current = (packRun.current ?? Promise.resolve())
      .then(() =>
        refreshPinnedThumbnailPack(
          pinnedThumbnailCandidates(gatewayBase, assets)
        )
      )
      // Forgetting the signature is the recovery: the next snapshot retries
      // instead of being skipped as "already done".
      .catch(() => {
        packSignature.current = undefined;
      });
  }, [gatewayBase, assets]);
}

/** Schedule the day's "on this day" notice, at most once per calendar day. */
export function useOnThisDayNotice(memories: readonly unknown[]): void {
  useEffect(() => {
    if (memories.length === 0) return;
    const key = `photos.onThisDay.${new Date().toISOString().slice(0, 10)}`;
    void Store.hydrate(key, false).then(async (scheduled) => {
      if (scheduled) return;
      const permission = await Notifications.getPermissionsAsync();
      if (!permission.granted) return;
      const fireAt = new Date();
      fireAt.setHours(18, 0, 0, 0);
      if (fireAt <= new Date()) fireAt.setTime(Date.now() + 60_000);
      await Notifications.scheduleNotificationAsync({
        content: {
          title: "On this day",
          body: `${memories.length} moments from years past`,
          data: { route: "Photos" },
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: fireAt,
        },
      });
      Store.set(key, true);
    });
  }, [memories]);
}
