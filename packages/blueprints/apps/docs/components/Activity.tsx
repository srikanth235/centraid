// The Details drawer's REAL activity trail (issue #352 phase 4): a plain
// read over consent.provenance (queries/activity.ts already did the read and
// the newest-first sort — this only renders it), replacing the old
// synthesized created_at/updated_at guess. Mirrors History.tsx's own
// load/denied/empty pattern exactly, down to the async-effect shape — the
// two panels are siblings inside the same drawer.
import { useEffect, useState } from '../react-core.min.js';
import { activityLabel, actorLabel, fmtFull } from '../format.ts';
import type { ActivityEvent } from '../types.ts';
import styles from './Activity.module.css';

interface ActivityResult {
  events?: ActivityEvent[];
  vaultDenied?: unknown;
}

export function Activity({
  documentId,
  loadActivity,
}: {
  documentId: string;
  loadActivity: (documentId: string) => Promise<ActivityResult>;
}) {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadActivity(documentId).then((res) => {
      if (cancelled) return;
      setEvents(res?.events ?? []);
      setDenied(Boolean(res?.vaultDenied));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (#360) loadActivity is a stable prop; Details.tsx keys this component by doc.document_id, so a real document change already remounts it fresh instead of re-running this effect
  }, [documentId]);

  if (events === null) return <div className={styles.activityStatus}>Loading activity…</div>;
  if (denied)
    return <div className={styles.activityStatus}>Ask the owner to approve activity access.</div>;
  // Honest empty state (a document seeded outside the command pipeline, or a
  // freshly recreated schema, has no provenance yet) — not an error.
  if (events.length === 0)
    return <div className={styles.activityStatus}>No activity recorded yet.</div>;

  return (
    <div>
      {events.map((ev, i) => (
        <div className={styles.activityItem} key={i}>
          <div className={styles.activityRail}>
            <span className={styles.activityDot}></span>
            {i < events.length - 1 ? <span className={styles.activityLine}></span> : null}
          </div>
          <div>
            <div className={styles.activityText}>
              {actorLabel(ev.agent_kind)} · {activityLabel(ev.activity)}
            </div>
            <div className={styles.activityMeta}>
              <span className={styles.activityDate}>{fmtFull(ev.occurred_at)}</span>
              <span className={styles.receiptChip}>receipt</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
