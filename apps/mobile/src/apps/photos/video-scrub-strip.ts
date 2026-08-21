// Scrub-preview frame planning for a video (issue #724 B2b) — pure math over
// a duration and a frame count, no native module, no react-native import. The
// generator that actually calls a poster-frame API lives in
// `video-scrub-strip-native.ts`; this module decides WHEN in the clip to ask
// it to look, so both can be asserted without a device.
//
// WHERE THIS IS HONESTLY WIRED (issue #724 B2b). `MediaPage.tsx` deliberately
// does NOT hand-roll a scrub transport for an ordinary video — its own header
// comment records that decision: `expo-video`'s `VideoView` with
// `nativeControls` already draws the platform's own scrubber, on both iOS and
// Android, and duplicating it would be exactly the two-transports-one-prop
// defect that comment describes fixing. A strip of preview frames belongs
// BEHIND that native control, which this app has no hook into — Expo does not
// expose a "preview thumbnail" slot on `VideoView`. The one hand-rolled
// scrub track this app DOES still own is the Live Photo `Transport`
// (`MediaPage.tsx`) — its track sits at a permanent zero because playback has
// not started yet, and it is exactly the shape a preview strip earns its
// place under: a member deciding whether to press Play can see the motion
// first. That is where `video-scrub-strip-native.ts`'s frames are drawn.

/** How many poster frames a strip carries. Small on purpose — each one is a
 *  real `expo-video-thumbnails` decode, and a Live Photo's whole point is that
 *  it is a few seconds long, not a scrub for a documentary. */
export const SCRUB_STRIP_FRAME_COUNT = 6;

/**
 * Evenly-spaced sample instants across a clip, in milliseconds — the first at
 * 0, the last just short of the end (a poster AT the exact duration can throw
 * on some decoders, having nothing left to seek to). A clip too short to hold
 * `count` distinct instants returns fewer rather than duplicate timestamps: a
 * 900ms Live Photo does not get six requests for the same three frames.
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
    // same clamped millisecond (a clip too short to hold `count` distinct
    // frames) are one frame, not two requests for the same decode.
    const at = Math.min(Math.round(i * step), ceiling);
    if (timestamps.length === 0 || at > timestamps[timestamps.length - 1]!)
      timestamps.push(at);
  }
  return timestamps;
}

/** One generated frame: when in the clip it was taken, and where its bytes
 *  live once `video-scrub-strip-native.ts` has produced it. */
export interface ScrubFrame {
  atMs: number;
  uri: string;
}
