// Docs §1.7: current tab = 2px INK bar + 500 weight — never a fill or app
// hue. Hidden on compact when the band owns nav; sidebar carries no copy.
import { DSHELVES, stripShelf } from "../shelves.ts";
import type { Shelf, ShelfId } from "../shelves.ts";

import styles from "./ShelfStrip.module.css";

export function ShelfStrip({
  shelf,
  onSelect,
  counts,
  narrow = false,
}: {
  shelf: ShelfId;
  onSelect: (id: ShelfId) => void;
  /** Per-shelf counts; omit empties — no invented zero. */
  counts?: ReadonlyMap<string, number>;
  narrow?: boolean;
}) {
  const current = stripShelf(shelf);
  return (
    <div
      className={styles.strip}
      role="tablist"
      aria-label="Shelves"
      data-narrow={narrow ? "true" : "false"}
    >
      {DSHELVES.map((entry: Shelf) => {
        const on = entry.id === current;
        const count = entry.id === null ? undefined : counts?.get(entry.id);
        return (
          <button
            key={entry.label}
            type="button"
            role="tab"
            aria-selected={on}
            className={styles.tab}
            data-current={on ? "true" : "false"}
            onClick={() => onSelect(entry.id)}
          >
            <span className={styles.tabLabel}>{entry.label}</span>
            {count === undefined ? null : (
              <span className={styles.tabCount}>{count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
