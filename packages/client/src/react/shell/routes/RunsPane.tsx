import { type JSX, useEffect, useState } from 'react';
import { formatDuration, relativeTime } from '../../../app-format.js';
import { listAutomationTurns, pinAutomationTurn } from '../../../gateway-client.js';
import styles from './RunsPane.module.css';

// The per-order run-history list inside the app-settings popover — the React
// successor to app-appview.ts's `loadRunsInto`/`renderRunRow`. Newest first;
// each row shows outcome + when + duration + summary and a pin toggle (pinned
// runs double as replay fixtures). Rendered into the host div AppSettingsPanel
// hands `onMountRuns`.
export default function RunsPane({ automationId }: { automationId: string }): JSX.Element {
  const [nonce, setNonce] = useState(0);
  // Stamped with the (automation, nonce) it was fetched for so a switch or a
  // pin-triggered refetch reads as "loading" during render — no effect has to
  // clear the previous result first.
  const [settled, setSettled] = useState<{
    key: string;
    result: CentraidAutomationTurnRecord[] | { error: string };
  } | null>(null);
  const key = `${automationId} ${nonce}`;
  const current = settled !== null && settled.key === key ? settled.result : null;
  const runs = Array.isArray(current) ? current : null;
  const error = current !== null && !Array.isArray(current) ? current.error : null;

  useEffect(() => {
    let alive = true;
    listAutomationTurns({ automationId, limit: 25 })
      .then((r) => {
        if (alive) setSettled({ key, result: r });
      })
      .catch((err: unknown) => {
        if (alive) {
          setSettled({
            key,
            result: { error: err instanceof Error ? err.message : String(err) },
          });
        }
      });
    return () => {
      alive = false;
    };
  }, [automationId, key]);

  const togglePin = (run: CentraidAutomationTurnRecord): void => {
    void pinAutomationTurn({ turnId: run.turnId, pinned: !run.pinned })
      .then(() => setNonce((n) => n + 1))
      .catch(() => setNonce((n) => n + 1));
  };

  if (error) return <div className={styles.empty}>{`Failed to load runs: ${error}`}</div>;
  if (!runs) return <div className={styles.empty}>Loading…</div>;
  if (runs.length === 0) return <div className={styles.empty}>No runs recorded yet.</div>;

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
              {run.endedAt !== undefined ? (
                <span className={styles.duration}>
                  {formatDuration(run.endedAt - run.startedAt)}
                </span>
              ) : null}
            </div>
            {run.summary || run.error ? (
              <div className={styles.summary}>{run.error ?? run.summary}</div>
            ) : null}
          </div>
          <button
            type="button"
            className={styles.pin}
            data-pinned={String(run.pinned)}
            aria-label={run.pinned ? 'Unpin run' : 'Pin run'}
            title={run.pinned ? 'Unpin' : 'Pin as replay fixture'}
            onClick={() => togglePin(run)}
          >
            ★
          </button>
        </div>
      ))}
    </div>
  );
}
