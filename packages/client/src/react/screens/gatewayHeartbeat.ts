import { formatClock, formatDuration } from "../shell/routes/gatewayData.js";
import type { BarDatum } from "../ui/BarsBlock.js";

// The heartbeat strip on System — availability as a SHAPE rather than as a
// percentage (binding layer v11).
//
// The hero already states "99.98%", and a percentage is the one reading that
// cannot answer the question people actually bring here: *when* did it stop.
// Two gateways both read 99.9% when one dropped a single probe a fortnight ago
// and the other dropped nine in a row this morning; only the picture separates
// them.
//
// WHAT THE WINDOW IS, said out loud. The prototype draws thirty days, one mark
// per day. The runtime wire carries no such thing: `samples` is a per-launch
// ring (`SAMPLE_CAP` probes, oldest first) that starts empty at every app
// launch and every gateway switch. Drawing it under a "30 days" axis would be
// a fabrication, so the axis, the note and the aria sentence all name THIS
// SESSION and the span it really covers. A durable daily series has to reach
// the gateway contract before the handoff's month can be drawn honestly.
//
// COLUMNS ARE PROBES, NOT MINUTES. Above `HEARTBEAT_COLUMNS` the ring folds
// into equal-sized groups of consecutive probes rather than equal stretches of
// time, because the poll is suspended while the window is hidden (issue #659)
// and a time axis would then draw a long flat nothing where the app was simply
// closed. Grouping by probe keeps every column carrying the same weight of
// evidence; the axis states the elapsed span beside it so neither reading is
// mistaken for the other.

/** One probe in the runtime sample ring — the wire's `CentraidGatewaySample`. */
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
  /** Fewer probes than the strip has room for — the plot packs the marks
   *  against the newest end instead of stretching them across it. */
  partial: boolean;
}

/**
 * Below this the strip is not a shape, it is two rectangles — and the hero's
 * availability fact already says everything two probes can say. A freshly
 * launched app therefore shows no chart at all rather than a chart that has
 * nothing to show.
 */
export const MIN_HEARTBEAT_SAMPLES = 3;

/** Matches the prototype's mark count. `BarsBlock` tightens its own gutter
 *  past this, so the ceiling is about legibility, not about capacity. */
export const HEARTBEAT_COLUMNS = 30;

/** Bucket `[start, end)` for column `index` of `columns` over `length` probes.
 *  Always at least one probe wide, so a short ring cannot produce an empty
 *  column that would draw as an unanswered heartbeat. */
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
    // The whole column is one bucket's worth of evidence, so the two segments
    // always sum to the plot: the FAILED SHARE is the reading, and the height
    // of the column carries no second meaning that could be misread.
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
