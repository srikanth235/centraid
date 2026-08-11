// The writes that need an answer (issue #738): denied, conflicted, or failed.
//
// Every other pending status renders as a chip on the row itself, because the
// replica still overlays it. These do not: settlement removed the optimistic
// mutation, so a denied ADD's row left the board entirely. That is exactly the
// silent-disappearance defect the issue exists to end, so the row is re-shown
// here — with its reason, and with the two things a member can actually do
// about it: retry it, or discard it. Neither happens on its own; nothing in
// this panel is ever auto-dismissed.
import type { PendingRowState } from "../../_shared/pending-overlay.ts";
import {
  pendingChipLabel,
  pendingReasonCopy,
} from "../../_shared/pending-overlay.ts";
import { displayText } from "../../_shared/untrusted.ts";

import styles from "./Attention.module.css";

/** What the write was, when its own payload carries no title to show. */
const ACTION_LABEL: Record<string, string> = {
  add: "New task",
  edit: "Task edit",
  "set-status": "Status change",
};

function rowLabel(row: PendingRowState): string {
  const title = row.input?.title;
  if (typeof title === "string" && title.trim()) return displayText(title);
  return ACTION_LABEL[row.action] ?? "Change";
}

export function Attention({
  rows,
  onRetry,
  onDiscard,
}: {
  rows: PendingRowState[];
  /** Re-issue the same payload under a fresh intent id. */
  onRetry: (intentId: string) => void;
  /** Forget it, here and in the durable attention journal. */
  onDiscard: (intentId: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <section className={styles.panel} aria-label="Changes that need you">
      <p className={styles.title}>These changes were not saved</p>
      {rows.map((row) => (
        <div className={styles.row} key={row.intentId}>
          <div className={styles.main}>
            <div className={styles.titleLine}>
              <span className={styles.label}>{rowLabel(row)}</span>
              <span className="kit-pending-chip">
                {pendingChipLabel(row.status)}
              </span>
            </div>
            <div className={styles.reason}>
              {pendingReasonCopy(
                row.status,
                row.reason ? { reason: row.reason } : {}
              )}
            </div>
            {/* A conflict says WHICH versions disagreed — the point of the
                precondition is lost if it degrades to a generic error. */}
            {row.conflict ? (
              <div className={styles.reason}>
                You were editing version {row.conflict.expectedVersion}; this
                device now sees version {row.conflict.actualVersion}.
              </div>
            ) : null}
          </div>
          <div className={styles.actions}>
            {/* Retry needs the payload back. A record whose input the outbox
                never journaled offers discard alone rather than a button that
                would quietly do nothing. */}
            {row.input ? (
              <button
                type="button"
                className="kit-btn"
                onClick={() => onRetry(row.intentId)}
              >
                Retry
              </button>
            ) : null}
            <button
              type="button"
              className="kit-btn"
              onClick={() => onDiscard(row.intentId)}
            >
              Discard
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
