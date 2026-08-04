import { useSyncExternalStore } from "react";
import type { CSSProperties, JSX } from "react";

import { readStatus, subscribeStatus } from "./statusChannel.js";

import chrome from "./chrome.module.css";

// The frame's one persistent status line (issue #707, invariant 5).
//
// It is always mounted and it never covers anything, which is what lets it
// replace every toast, spinner and badge in the shell. Three states, in
// priority order:
//
//   1. offline  — a BORDERED banner state. `--net` is the "leaves the device"
//                 role, and the brief allows it as a border or a 2px rule and
//                 never as a fill, so the line takes a rule rather than
//                 turning red. The reason is inline; there is no tooltip,
//                 because a tooltip has no mobile.
//   2. a note   — whatever `statusLine.ts` was last told, optionally with a
//                 determinate bar and exact counts, or one bounded action.
//   3. ambient  — the standing sentence for the current route.
//
// The whole line is `role="status"` / `aria-live="polite"`: it is the shell's
// announcement channel, so a screen reader hears what a sighted reader sees,
// once, without the message stealing focus.

/** Counts are numerics, so they are mono and tabular — and grouped, because
 *  "1904" and "1,904" are not equally readable at 11.5px. */
const count = (n: number): string => n.toLocaleString();

export interface StatusLineProps {
  /** The standing sentence when nothing transient is showing. */
  ambient: string;
  /** The gateway is unreachable: commits are disabled and this says why. */
  offline?: boolean;
  /** The inline reason. Required reading when `offline` — never a tooltip. */
  offlineReason?: string;
  /** One bounded control on the offline banner (e.g. "Check gateway"). */
  offlineAction?: { label: string; run: () => void };
}

export default function StatusLine({
  ambient,
  offline,
  offlineReason,
  offlineAction,
}: StatusLineProps): JSX.Element {
  const note = useSyncExternalStore(subscribeStatus, readStatus, readStatus);
  const progress = note?.progress;
  const text = offline ? (offlineReason ?? ambient) : (note?.text ?? ambient);
  const action = offline ? offlineAction : note?.action;

  return (
    <output
      className={chrome.statusLine}
      data-offline={offline ? "true" : undefined}
      aria-live="polite"
    >
      <span className={chrome.statusDot} aria-hidden="true" />
      <span className={chrome.statusText}>{text}</span>
      {progress ? (
        <>
          {/* Determinate, always. A local operation knows its own size, and a
              spinner would be the one thing this product can never honestly
              say: "I don't know how long". */}
          <span
            className={chrome.statusBar}
            style={
              {
                // A ratio, not a width: the track owns its own length, so the
                // fill scales without the component knowing any pixels.
                "--status-progress":
                  progress.total > 0 ? progress.done / progress.total : 0,
              } as CSSProperties
            }
            aria-hidden="true"
          />
          <span className={chrome.statusCounts}>
            {count(progress.done)} of {count(progress.total)}
            {progress.unit ? ` ${progress.unit}` : ""}
          </span>
        </>
      ) : null}
      {action ? (
        <button
          className={chrome.statusAction}
          type="button"
          onClick={() => action.run()}
        >
          {action.label}
        </button>
      ) : null}
    </output>
  );
}
