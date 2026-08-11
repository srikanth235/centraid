// The writes that need an answer (issue #738): denied, conflicted, or failed.
//
// Every other pending status renders as the chip on the row itself, because
// the replica still overlays it. These do not: settlement removed the
// optimistic mutation, so a denied trash snapped the document back out of the
// trash and a denied `create-folder`'s folder left the sidebar entirely. That
// is exactly the silent-disappearance defect the issue exists to end, so the
// write is re-shown here — with its reason, and with what a member can
// actually do about it. Nothing here is ever auto-dismissed.
import type { PendingRowState } from "../../_shared/pending-overlay.ts";
import {
  pendingChipLabel,
  pendingReasonCopy,
} from "../../_shared/pending-overlay.ts";
import { displayText } from "../../_shared/untrusted.ts";

import styles from "./Attention.module.css";

/** What the write was, when its own payload carries no name to show. */
const ACTION_LABEL: Record<string, string> = {
  rename: "Rename",
  move: "Move",
  trash: "Move to trash",
  restore: "Restore",
  "create-folder": "New folder",
  "rename-folder": "Folder rename",
  "delete-folder": "Folder deletion",
};

function rowLabel(row: PendingRowState): string {
  const name = row.input?.title ?? row.input?.name;
  if (typeof name === "string" && name.trim()) return displayText(name);
  return ACTION_LABEL[row.action] ?? "Change";
}

export function Attention({
  rows,
  isEditable,
  onEdit,
  onRetry,
  onDiscard,
}: {
  rows: PendingRowState[];
  /** True where this app can reopen the REFUSED payload on a surface of its
   *  own — the rename prompt and the sidebar's two folder-name fields. A
   *  move/trash/restore carries no text to correct, so it offers retry and
   *  discard alone rather than an empty surface. */
  isEditable: (row: PendingRowState) => boolean;
  onEdit: (intentId: string) => void;
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
            {/* Edit/Retry need the payload back. A record whose input the
                outbox never journaled offers discard alone rather than
                buttons that would quietly do nothing. */}
            {row.input && isEditable(row) ? (
              <button
                type="button"
                className="kit-btn"
                onClick={() => onEdit(row.intentId)}
              >
                Edit
              </button>
            ) : null}
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
