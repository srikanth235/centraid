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

const count = (n: number): string => n.toLocaleString();

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
