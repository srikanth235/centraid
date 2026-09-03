import * as VideoThumbnails from "expo-video-thumbnails";
import { Platform } from "react-native";

import type { ScrubFrame } from "./video-scrub-strip";
import { scrubFrameTimestampsMs } from "./video-scrub-strip";

function scrubStripSupported(): boolean {
  return Platform.OS === "ios" || Platform.OS === "android";
}

export async function generateScrubStrip(
  uri: string,
  durationMs: number
): Promise<ScrubFrame[]> {
  if (!scrubStripSupported()) return [];
  const timestamps = scrubFrameTimestampsMs(durationMs);
  const frames: ScrubFrame[] = [];
  for (const atMs of timestamps) {
    try {
      // oxlint-disable-next-line no-await-in-loop
      const result = await VideoThumbnails.getThumbnailAsync(uri, {
        time: atMs,
        quality: 0.7,
      });
      frames.push({ atMs, uri: result.uri });
    } catch {
      // Intentionally empty.
    }
  }
  return frames;
}
