// The Details drawer's REAL activity trail (issue #352 phase 4): a plain
// read over consent.provenance (queries/activity.js already did the read and
// the newest-first sort — this only renders it), replacing the old
// synthesized created_at/updated_at guess. Mirrors History.jsx's own
// load/denied/empty pattern exactly, down to the async-effect shape — the
// two panels are siblings inside the same drawer.
import { useEffect, useState } from '../react-core.min.js';
import { activityLabel, actorLabel, fmtFull } from '../format.js';

export function Activity({ documentId, loadActivity }) {
  const [events, setEvents] = useState(null);
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
    // eslint-disable-next-line
  }, [documentId]);

  if (events === null) return <div className="d-activity-status">Loading activity…</div>;
  if (denied)
    return <div className="d-activity-status">Ask the owner to approve activity access.</div>;
  // Honest empty state (a document seeded outside the command pipeline, or a
  // freshly recreated schema, has no provenance yet) — not an error.
  if (events.length === 0)
    return <div className="d-activity-status">No activity recorded yet.</div>;

  return (
    <div>
      {events.map((ev, i) => (
        <div className="d-activity-item" key={i}>
          <div className="d-activity-rail">
            <span className="d-activity-dot"></span>
            {i < events.length - 1 ? <span className="d-activity-line"></span> : null}
          </div>
          <div>
            <div className="d-activity-text">
              {actorLabel(ev.agent_kind)} · {activityLabel(ev.activity)}
            </div>
            <div className="d-activity-meta">
              <span className="d-activity-date">{fmtFull(ev.occurred_at)}</span>
              <span className="d-receipt-chip">receipt</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
