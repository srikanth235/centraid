// The generator behind `video-scrub-strip.ts`'s plan: real poster frames, via
// the SAME `expo-video-thumbnails` call `generateDeviceDerivatives`
// (`lib/upload/derivatives-native.ts`) already uses for a video's single
// upload-time poster — this asks it for several timestamps down one clip
// instead of one at `time: 0`. No native dependency beyond the one
// `apps/mobile/package.json` already carries.
//
// PLATFORM HONESTY. `expo-video-thumbnails` documents frame extraction as
// working on iOS and Android; it has no web implementation (the package's own
// platform table lists web as unsupported). Rather than let a bare
// `getThumbnailAsync` call throw on web and turn a scrub gesture into a
// silent dead strip, `generateScrubStrip` below refuses to try there and
// returns an EMPTY array instead — its one caller (`Transport` in
// `MediaPage.tsx`) already renders nothing for an empty strip and falls back
// to its plain static track, so web genuinely gets fewer frames, honestly,
// rather than a crash or a fabricated single frame pretending to be a strip.

import * as VideoThumbnails from "expo-video-thumbnails";
import { Platform } from "react-native";

import type { ScrubFrame } from "./video-scrub-strip";
import { scrubFrameTimestampsMs } from "./video-scrub-strip";

/** True where `expo-video-thumbnails` can actually extract a frame. */
function scrubStripSupported(): boolean {
  return Platform.OS === "ios" || Platform.OS === "android";
}

/**
 * Generate a scrub strip for one video, already-opened at `uri`. Frames that
 * fail to decode are DROPPED, not retried and not padded with a duplicate —
 * a partial strip (five real frames instead of six) is the honest result of
 * a codec that stumbled on one timestamp; inventing a sixth would claim a
 * frame this clip never actually showed.
 */
export async function generateScrubStrip(
  uri: string,
  durationMs: number
): Promise<ScrubFrame[]> {
  if (!scrubStripSupported()) return [];
  const timestamps = scrubFrameTimestampsMs(durationMs);
  const frames: ScrubFrame[] = [];
  for (const atMs of timestamps) {
    try {
      // Serial, not `Promise.all`: each call decodes a video frame on the
      // native side, and six of those in flight at once is six times the
      // memory pressure for a strip nobody is looking at yet mid-generation.
      // oxlint-disable-next-line no-await-in-loop
      const result = await VideoThumbnails.getThumbnailAsync(uri, {
        time: atMs,
        quality: 0.7,
      });
      frames.push({ atMs, uri: result.uri });
    } catch {
      // Recovery, not a swallow: one unreadable instant costs this clip one
      // frame of preview, never the whole strip and never a thrown scrub.
    }
  }
  return frames;
}
