import { formatClock, formatDuration } from "../shell/routes/gatewayData.js";
import type { BarDatum } from "../ui/BarsBlock.js";

// Heartbeat strip: availability as a shape, this session only. `samples` is a
// per-launch ring — a "30 days" axis would fabricate a window the wire does
// not carry. Columns are probes, not minutes: the poll is suspended while
// hidden (#659), so a time axis would draw a flat nothing while closed.

export interface HeartbeatSample {
  at: number;
  ok: boolean;
  latencyMs?: number;
}

export interface HeartbeatStrip {
  bars: BarDatum[];
  axis: string[];
  ariaLabel: string;
  note: string;
  legend: { ok: string; fail: string };
  /** Pack marks against the newest end; do not stretch a short ring. */
  partial: boolean;
}

/** A chart of two probes is not a shape; hide it rather than draw nothing. */
export const MIN_HEARTBEAT_SAMPLES = 3;

export const HEARTBEAT_COLUMNS = 30;

/** Always at least one probe wide — a short ring must not draw an empty column. */
function bucketRange(
  index: number,
  columns: number,
  length: number
): [number, number] {
  const start = Math.floor((index * length) / columns);
  const end = Math.floor(((index + 1) * length) / columns);
  return [start, Math.max(end, start + 1)];
}

export function buildHeartbeatStrip(
  samples: readonly HeartbeatSample[],
  now: number,
  columns: number = HEARTBEAT_COLUMNS
): HeartbeatStrip | null {
  const first = samples[0];
  if (first === undefined || samples.length < MIN_HEARTBEAT_SAMPLES)
    return null;

  const width = Math.min(columns, samples.length);
  const bars: BarDatum[] = [];
  for (let index = 0; index < width; index += 1) {
    const [start, end] = bucketRange(index, width, samples.length);
    const bucket = samples.slice(start, end);
    const failed = bucket.filter((sample) => !sample.ok).length;
    const fail = (failed / bucket.length) * 100;
    const at = bucket[0]?.at ?? first.at;
    bars.push({
      fail,
      id: `hb-${at}-${index}`,
      label:
        failed === 0
          ? `${formatClock(at)} · answering`
          : `${formatClock(at)} · ${failed} of ${bucket.length} did not answer`,
      ok: 100 - fail,
    });
  }

  const span = formatDuration(Math.max(0, now - first.at));
  const failedTotal = samples.filter((sample) => !sample.ok).length;
  const lastFailure = samples.findLast((sample) => !sample.ok);

  return {
    ariaLabel: `Whether the gateway answered, ${width} mark${width === 1 ? "" : "s"} over the ${span} this session has been watched`,
    axis:
      width >= 3 ? [`${span} ago`, "halfway", "now"] : [`${span} ago`, "now"],
    bars,
    legend: { fail: "did not answer", ok: "answering" },
    partial: width < columns,
    note:
      failedTotal === 0 || lastFailure === undefined
        ? `Every one of ${samples.length.toLocaleString()} heartbeats was answered. This session only — the strip starts empty at each launch.`
        : `${failedTotal.toLocaleString()} of ${samples.length.toLocaleString()} heartbeats went unanswered, the last at ${formatClock(lastFailure.at)}. This session only — the strip starts empty at each launch.`,
  };
}
