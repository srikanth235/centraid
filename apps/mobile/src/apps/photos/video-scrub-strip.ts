export const SCRUB_STRIP_FRAME_COUNT = 6;

export function scrubFrameTimestampsMs(
  durationMs: number,
  count: number = SCRUB_STRIP_FRAME_COUNT
): number[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return [0];
  const ceiling = Math.max(0, durationMs - 1);
  const step = durationMs / count;
  const timestamps: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = Math.min(Math.round(i * step), ceiling);
    if (timestamps.length === 0 || at > timestamps[timestamps.length - 1]!)
      timestamps.push(at);
  }
  return timestamps;
}

export interface ScrubFrame {
  atMs: number;
  uri: string;
}
