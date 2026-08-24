import { useEffect, useState, useSyncExternalStore } from "react";
import type { CSSProperties, JSX } from "react";

import { syncedStamp } from "./ambientStatus.js";
import {
  readRouteHealth,
  readStatus,
  subscribeStatus,
} from "./statusChannel.js";
import { useGatewayCheck } from "./useGatewayRuntime.js";

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
//   2. a note   — whatever `postStatus` was last told, optionally with a
//                 determinate bar and exact counts, or one bounded action.
//   3. health   — the standing condition of the route you are on (#765), set
//                 by the route's own loader through `setRouteHealth`. It sits
//                 UNDER a transient note because a note is news and health is
//                 a condition: the news passes, and the condition is still
//                 there when it does.
//   4. ambient  — the standing sentence for the shell as a whole.
//
// The whole line is `role="status"` / `aria-live="polite"`: it is the shell's
// announcement channel, so a screen reader hears what a sighted reader sees,
// once, without the message stealing focus.

/** Counts are numerics, so they are mono and tabular — and grouped, because
 *  "1904" and "1,904" are not equally readable at 11.5px. */
const count = (n: number): string => n.toLocaleString();

/**
 * How long ago the last heartbeat landed, appended to the STANDING sentence.
 *
 * "Synced" with no age on it reads the same one second after a probe and ten
 * minutes after the machine went to sleep — the state that most needs to be
 * visible looked exactly like the state that is fine. The stamp lives in its
 * own leaf component with its own subscription and its own ticker, so the
 * shell root above it still does not re-render on the heartbeat (issue #659).
 *
 * It draws nothing unless the gateway is answering: an unreachable gateway is
 * already the offline banner's subject, and "synced 4 min ago" under it would
 * be a second, softer account of the same thing.
 */
function SyncedStamp(): JSX.Element | null {
  const { status, lastCheckAt } = useGatewayCheck();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (status !== "up") return null;
  const stamp = syncedStamp(lastCheckAt, now);
  if (stamp === undefined) return null;
  return <span className={chrome.statusStamp}>{stamp}</span>;
}

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
  const health = useSyncExternalStore(
    subscribeStatus,
    readRouteHealth,
    readRouteHealth
  );
  const progress = note?.progress;
  // The standing line, when there is no news to put over it.
  const standing = note ?? health;
  const text = offline
    ? (offlineReason ?? ambient)
    : (standing?.text ?? ambient);
  const action = offline ? offlineAction : standing?.action;
  // Only the ROUTE's own verb takes the page tone and the inline rule; an undo
  // or an offline check is a shell control and keeps the bounded shape.
  const inline = !offline && !note && Boolean(health?.action);

  return (
    <output
      className={chrome.statusLine}
      data-offline={offline ? "true" : undefined}
      aria-live="polite"
    >
      <span className={chrome.statusDot} aria-hidden="true" />
      <span className={chrome.statusText}>{text}</span>
      {/* Only under the STANDING sentence: a note is news about a moment, and
          stamping it with the heartbeat's age would date the wrong thing. */}
      {offline || standing ? null : <SyncedStamp />}
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
          data-inline={inline ? "true" : undefined}
          data-tone={inline ? health?.tone : undefined}
          onClick={() => action.run()}
        >
          {action.label}
        </button>
      ) : null}
    </output>
  );
}
