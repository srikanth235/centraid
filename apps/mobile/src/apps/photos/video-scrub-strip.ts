// Scrub-preview timestamps (#724) — pure math, no native import.
// Do not wire this under an ordinary `VideoView`: nativeControls already
// draws the platform scrubber, and Expo exposes no thumbnail slot behind it.
// The only owned scrub track is Live Photo `Transport` in `MediaPage.tsx`
// (track at zero until Play); `video-scrub-strip-native.ts` draws there.

/** Small on purpose — each frame is a real decode, and a Live Photo is seconds long. */
export const SCRUB_STRIP_FRAME_COUNT = 6;

/**
 * Evenly-spaced instants in ms; last is just short of duration (a poster AT
 * the exact end throws on some decoders). A clip too short to hold `count`
 * distinct instants returns fewer rather than duplicate timestamps.
 */
export function scrubFrameTimestampsMs(
  durationMs: number,
  count: number = SCRUB_STRIP_FRAME_COUNT
): number[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return [0];
  const ceiling = Math.max(0, durationMs - 1);
  const step = durationMs / count;
  const timestamps: number[] = [];
  for (let i = 0; i < count; i += 1) {
    // Clamp BEFORE the duplicate check — two raw instants that round to the
    // same clamped ms are one frame, not two decode requests.
    const at = Math.min(Math.round(i * step), ceiling);
    if (timestamps.length === 0 || at > timestamps[timestamps.length - 1]!)
      timestamps.push(at);
  }
  return timestamps;
}

/** When in the clip the frame was taken, and the uri once native produced it. */
export interface ScrubFrame {
  atMs: number;
  uri: string;
}
