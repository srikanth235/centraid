import { useEffect, useState } from "react";

import { relTime } from "@centraid/design/elements";

import styles from "./History.module.css";

interface Revision {
  revision_id: string;
  operation: string;
  recorded_at: string;
  undo_until: string;
  undone_at?: string | null;
}

export function History({
  partyId,
  onUndo,
}: {
  partyId: string;
  onUndo: (revisionId: string) => void;
}) {
  const [rows, setRows] = useState<Revision[] | null>(null);
  const [denied, setDenied] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    void window.centraid
      .read<{ revisions?: Revision[]; vaultDenied?: unknown }>({
        query: "history",
        input: { party_id: partyId },
      })
      .then((result) => {
        if (cancelled) return;
        setRows(result.revisions ?? []);
        setDenied(Boolean(result.vaultDenied));
      })
      .catch(() => {
        if (!cancelled) setDenied(true);
      });
    return () => {
      cancelled = true;
    };
  }, [partyId]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (rows === null) return <p className={styles.status}>Loading history…</p>;
  if (denied)
    return <p className={styles.status}>History access needs approval.</p>;
  if (rows.length === 0)
    return <p className={styles.status}>No changes recorded yet.</p>;
  return (
    <div className={styles.list}>
      {rows.map((row) => {
        const undoable = !row.undone_at && Date.parse(row.undo_until) >= now;
        return (
          <div className={styles.row} key={row.revision_id}>
            <div>
              <strong>{row.operation}</strong>
              <span>{relTime(row.recorded_at)}</span>
            </div>
            {undoable ? (
              <button
                type="button"
                className="kit-btn"
                onClick={() => onUndo(row.revision_id)}
              >
                Undo
              </button>
            ) : (
              <span className={styles.done}>
                {row.undone_at ? "Undone" : "Recorded"}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
