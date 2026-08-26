// Shelf strip (v4 handoff §5). NOT RENDERED where the phone app band owns
// the shelves (§3, §15), nor in album detail.
import type { Shelf, ShelfId } from "../shelves.ts";
import { SHELVES } from "../shelves.ts";

import styles from "./ShelfStrip.module.css";

export function ShelfStrip({
  shelf,
  onSelect,
  narrow = false,
}: {
  shelf: ShelfId;
  onSelect: (id: ShelfId) => void;
  narrow?: boolean;
}) {
  return (
    <div
      className={styles.strip}
      role="tablist"
      aria-label="Shelves"
      data-narrow={narrow ? "true" : "false"}
    >
      {SHELVES.map((entry: Shelf) => {
        const current = entry.id === shelf;
        return (
          <button
            key={entry.label}
            type="button"
            role="tab"
            aria-selected={current}
            className={styles.tab}
            data-current={current ? "true" : "false"}
            onClick={() => onSelect(entry.id)}
          >
            <span className={styles.tabLabel}>{entry.label}</span>
          </button>
        );
      })}
    </div>
  );
}
