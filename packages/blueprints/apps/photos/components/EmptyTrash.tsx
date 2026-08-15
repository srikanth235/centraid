// Empty trash — the Trash shelf's own action (v4 handoff §4.5, proto:4800-4803).
//
// THE CONTROL IS NOT THE DELETION. Pressing `Empty trash` opens a confirm that
// names the exact number, what leaves with them, and that it cannot be undone;
// only the second press destroys anything. That two-step is the entire safety
// story for the one irreversible act in this app, which is why it lives in a
// component of its own rather than as a button someone can later "simplify"
// into a single tap.
//
// OUTLINED `--net`, NEVER FILLED (§18, proto:4802). The frame's app bar owns
// the one filled ink control in the view; a destructive action that shouted
// louder than Import would be inviting the press it most needs the member to
// think about.
//
// NO UNDO. The narration this fires (trash-actions.ts) never passes the status
// line's undo slot — see that file's head for why.
import { useState } from "react";

import { fmtBytes } from "@centraid/design/elements";

import { canWriteScope, mountedScopes } from "../../_shared/scope-kit.ts";
import { assetBytes } from "../format.ts";
import { runEmptyTrash } from "../trash-actions.ts";
import type { Asset } from "../types.ts";
import { EMPTY_TRASH_COPY, TRASH_NOTE } from "../view-copy.ts";

import styles from "./EmptyTrash.module.css";

export interface EmptyTrashProps {
  /** Every photograph on the Trash shelf, in the shelf's own order. */
  trash: readonly Asset[];
  /** Re-read the library once the run has finished. */
  refresh: () => Promise<void>;
}

/** The first scope in this trash the member may not delete from, if any. */
function blockedLabel(trash: readonly Asset[]): string | null {
  const blocked = trash.find((asset) => !canWriteScope(asset.scope_id));
  if (!blocked) return null;
  const scope = mountedScopes().find(
    (candidate) => candidate.id === (blocked.scope_id ?? "")
  );
  return scope ? scope.label : "that library";
}

/**
 * The Trash shelf's head: the shelf note, then the action. Renders the note
 * alone on an empty shelf — a destroy control with nothing to destroy is a
 * control that can only disappoint.
 */
export function EmptyTrash({ trash, refresh }: EmptyTrashProps) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const count = trash.length;
  // Deleting from a read-only audience is refused by the shell anyway; saying
  // so on the control beats firing a write whose refusal the member has to
  // read after the fact.
  const blocked = blockedLabel(trash);
  let bytes = 0;
  for (const asset of trash) bytes += assetBytes(asset) ?? 0;
  const handleOpen = (): void => setConfirming(true);
  const handleCancel = (): void => setConfirming(false);
  const handleConfirm = (): void => {
    setConfirming(false);
    void runEmptyTrash(trash, { refresh, setBusy });
  };
  return (
    <div className={styles.head}>
      <p className={styles.note}>{TRASH_NOTE}</p>
      {count === 0 ? null : confirming ? (
        <fieldset className={styles.confirm}>
          <p className={styles.question}>{EMPTY_TRASH_COPY.question(count)}</p>
          <p className={styles.detail}>
            {EMPTY_TRASH_COPY.detail(count, fmtBytes(bytes, "space they hold"))}
          </p>
          <div className={styles.row}>
            <button
              type="button"
              className={`kit-btn ${styles.destructive}`}
              onClick={handleConfirm}
            >
              {EMPTY_TRASH_COPY.confirm(count)}
            </button>
            <button type="button" className="kit-btn" onClick={handleCancel}>
              {EMPTY_TRASH_COPY.cancel}
            </button>
          </div>
        </fieldset>
      ) : (
        <div className={styles.row}>
          <button
            type="button"
            className={`kit-btn ${styles.destructive}`}
            disabled={busy || blocked !== null}
            onClick={handleOpen}
          >
            {EMPTY_TRASH_COPY.control}
          </button>
          {blocked === null ? null : (
            <p className={styles.reason}>
              {EMPTY_TRASH_COPY.readOnly(blocked)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
