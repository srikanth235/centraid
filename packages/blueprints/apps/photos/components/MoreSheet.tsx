// Overflow sheet for shelves off the band (§3.1/§15); no icon import — the
// app bar owns the filled verb.
import { MORE_DESTINATIONS } from "../shelves.ts";
import type { ShelfId } from "../shelves.ts";

import styles from "./MoreSheet.module.css";

export function MoreSheet({
  shelf,
  counts,
  onSelect,
  onClose,
}: {
  shelf: ShelfId;
  counts?: ReadonlyMap<string, number>;
  onSelect: (id: ShelfId) => void;
  onClose: () => void;
}) {
  return (
    // Never showModal(): a modal takes the top layer over frame chrome.
    <dialog open className={styles.sheet} aria-label="More in Photos">
      <div className={styles.grabber} aria-hidden="true" />
      <nav className={styles.rows}>
        {MORE_DESTINATIONS.map((destination) => {
          const count =
            destination.id === null ? undefined : counts?.get(destination.id);
          return (
            <button
              key={destination.segment}
              type="button"
              className={styles.row}
              {...(destination.id === shelf ? { "aria-current": "page" } : {})}
              onClick={() => onSelect(destination.id)}
            >
              <span className={styles.label}>{destination.label}</span>
              {count === undefined ? null : (
                <span className={styles.count}>{count}</span>
              )}
            </button>
          );
        })}
      </nav>
      <button
        type="button"
        className={`kit-btn ${styles.close}`}
        onClick={onClose}
      >
        Close
      </button>
    </dialog>
  );
}
