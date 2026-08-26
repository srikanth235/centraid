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

// Frame's one persistent status line (#707, invariant 5). Always mounted,
// never covers anything. Priority: offline `--net` rule (never a fill, reason
// inline — no tooltip); `postStatus` note; route health UNDER a transient
// note; ambient. `role="status"` / `aria-live="polite"`.

/** Counts are mono and tabular — grouped, because "1904" and "1,904" are not
 *  equally readable at 11.5px. */
const count = (n: number): string => n.toLocaleString();

/**
 * Heartbeat age on the STANDING sentence only. Own leaf + ticker so the
 * shell root still does not re-render (#659). Nothing unless the gateway
 * is answering — unreachable is already the offline banner.
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
  ambient: string;
  offline?: boolean;
  /** Required reading when `offline` — never a tooltip. */
  offlineReason?: string;
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
      {/* Only under the STANDING sentence: a note is news about a moment. */}
      {offline || standing ? null : <SyncedStamp />}
      {progress ? (
        <>
          {/* Determinate, always. A local operation knows its size; a spinner
              would say "I don't know how long". */}
          <span
            className={chrome.statusBar}
            style={
              {
                // A ratio, not a width: the track owns its length.
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
