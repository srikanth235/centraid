// Emptying the trash (Docs spec §4.3, §14; #1015 D1).
//
// THE CONTROL IS NOT THE DELETION. Press opens the confirm; only the confirm
// writes. The confirm names the count and the finality first, and the
// destructive control is outlined `--net` and never filled — an irreversible
// verb must not look louder than Upload.
//
// This panel replaced an ASK ("Delete forever and Empty trash — not available
// yet"). The vault command it asked for is `core.empty_document_trash`, and
// Photos had already shipped the same question in the same words; Docs saying
// "a trash cannot be emptied" was the divergence, not the feature.
import { useState } from "react";

import { EMPTY_TRASH_COPY, TRASH_NOTE } from "../drive-copy.ts";

import styles from "./EmptyTrash.module.css";

export interface EmptyTrashProps {
  /** How many documents are in the trash right now. */
  count: number;
  onEmptyTrash: () => void;
}

/** Shelf foot: the note always, the verb only when there is something to empty. */
export function EmptyTrash({ count, onEmptyTrash }: EmptyTrashProps) {
  const [confirming, setConfirming] = useState(false);
  return (
    <section className={styles.panel} aria-label={EMPTY_TRASH_COPY.control}>
      <p className={styles.note}>{TRASH_NOTE}</p>
      {count === 0 ? (
        <p className={styles.note}>{EMPTY_TRASH_COPY.empty}</p>
      ) : confirming ? (
        <fieldset className={styles.confirm}>
          <p className={styles.question}>{EMPTY_TRASH_COPY.question(count)}</p>
          <p className={styles.detail}>{EMPTY_TRASH_COPY.detail(count)}</p>
          <div className={styles.row}>
            <button
              type="button"
              className={`kit-btn ${styles.destructive}`}
              onClick={() => {
                setConfirming(false);
                onEmptyTrash();
              }}
            >
              {EMPTY_TRASH_COPY.confirm(count)}
            </button>
            <button
              type="button"
              className="kit-btn"
              onClick={() => setConfirming(false)}
            >
              {EMPTY_TRASH_COPY.cancel}
            </button>
          </div>
        </fieldset>
      ) : (
        <div className={styles.row}>
          <button
            type="button"
            className={`kit-btn ${styles.destructive}`}
            onClick={() => setConfirming(true)}
          >
            {EMPTY_TRASH_COPY.label(count)}
          </button>
        </div>
      )}
    </section>
  );
}
