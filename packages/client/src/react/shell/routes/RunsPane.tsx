import type { JSX } from "react";

import { formatDuration, relativeTime } from "../../../app-format.js";
import {
  listAutomationTurns,
  pinAutomationTurn,
} from "../../../gateway-client.js";
import { useCachedQuery } from "../queryCache.js";
import { postStatus } from "../statusChannel.js";

import styles from "./RunsPane.module.css";

// The per-order run-history list inside the app-settings popover — the React
// successor to app-appview.ts's `loadRunsInto`/`renderRunRow`. Newest first;
// each row shows outcome + when + duration + summary and a pin toggle (pinned
// runs double as replay fixtures). Rendered into the host div AppSettingsPanel
// hands `onMountRuns`.
export default function RunsPane({
  automationId,
}: {
  automationId: string;
}): JSX.Element {
  // Keyed on the automation (docs/client-keying.md): reopening the popover for
  // the same order paints its runs immediately from cache and revalidates
  // behind them, and a pin no longer destroys the list to rebuild it.
  const { state, mutate } = useCachedQuery(
    `automation-runs:${automationId}`,
    () => listAutomationTurns({ automationId, limit: 25 })
  );
  const runs = state.status === "ready" ? state.data : undefined;
  const loadError = state.status === "error" ? state.error : null;

  const togglePin = (run: CentraidAutomationTurnRecord): void => {
    const pinned = !run.pinned;
    // The star fills on the click; the wire call confirms it. A rejection puts
    // the previous list back exactly (queryCache.mutate).
    void mutate(
      (rows) =>
        rows.map((row) =>
          row.turnId === run.turnId ? { ...row, pinned } : row
        ),
      () => pinAutomationTurn({ turnId: run.turnId, pinned })
    ).catch((error: unknown) =>
      postStatus(
        `Couldn't ${pinned ? "pin" : "unpin"} that run: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  };

  if (loadError)
    return (
      <div className={styles.empty}>{`Failed to load runs: ${loadError}`}</div>
    );
  if (!runs) return <div className={styles.empty}>Loading…</div>;
  if (runs.length === 0)
    return <div className={styles.empty}>No runs recorded yet.</div>;

  return (
    <div className={styles.list}>
      {runs.map((run) => (
        <div key={run.turnId} className={styles.run} data-ok={String(run.ok)}>
          <span className={styles.status} aria-hidden="true" />
          <div className={styles.body}>
            <div className={styles.head}>
              <span className={styles.when}>
                {relativeTime(new Date(run.startedAt).toISOString())}
              </span>
              <span className={styles.trigger}>{run.triggerKind}</span>
              {run.endedAt === undefined ? null : (
                <span className={styles.duration}>
                  {formatDuration(run.endedAt - run.startedAt)}
                </span>
              )}
            </div>
            {run.summary || run.error ? (
              <div className={styles.summary}>{run.error ?? run.summary}</div>
            ) : null}
          </div>
          <button
            type="button"
            className={styles.pin}
            data-pinned={String(run.pinned)}
            aria-label={run.pinned ? "Unpin run" : "Pin run"}
            title={run.pinned ? "Unpin" : "Pin as replay fixture"}
            onClick={() => togglePin(run)}
          >
            ★
          </button>
        </div>
      ))}
    </div>
  );
}
