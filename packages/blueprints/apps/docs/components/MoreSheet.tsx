import type { ShelfId } from "../shelves.ts";
// Docs §1.5: the compact band's sixth slot is a sheet, not a second band.
import { MORE_FOOTER, MORE_ROWS, MORE_TITLE } from "../view-copy.ts";

import styles from "./MoreSheet.module.css";

export function MoreSheet({
  shelf,
  counts,
  onSelect,
  onClose,
}: {
  /** Per-shelf counts; omit rather than zero. */
  shelf: ShelfId;
  counts?: ReadonlyMap<string, number>;
  onSelect: (id: ShelfId) => void;
  onClose: () => void;
}) {
  return (
    // Native <dialog open>, never showModal(): modals take the top layer over frame chrome.
    <dialog open className={styles.sheet} aria-label={MORE_TITLE}>
      <div className={styles.grabber} aria-hidden="true" />
      <nav className={styles.rows}>
        {MORE_ROWS.filter((row) => row.live).map((row) => {
          const count =
            typeof row.shelf === "string" ? counts?.get(row.shelf) : undefined;
          const meta =
            count === undefined
              ? row.meta
              : row.meta
                ? `${count} · ${row.meta}`
                : String(count);
          return (
            <button
              key={row.label}
              type="button"
              className={styles.row}
              {...(row.shelf === shelf ? { "aria-current": "page" } : {})}
              onClick={() => onSelect(row.shelf)}
            >
              <span className={styles.label}>{row.label}</span>
              {meta === undefined ? null : (
                <span className={styles.meta}>{meta}</span>
              )}
            </button>
          );
        })}
      </nav>
      {/* §1.5's closing sentence. */}
      <p className={styles.footer}>{MORE_FOOTER}</p>
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
