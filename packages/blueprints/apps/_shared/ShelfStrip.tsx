import type { ReactNode } from "react";

import type { Shelf, ShelfId } from "./shelves.ts";

import styles from "./ShelfStrip.module.css";

export interface ShelfStripProps {
  shelves: readonly Shelf[];
  current: ShelfId;
  onSelect: (id: ShelfId) => void;
  counts?: ReadonlyMap<string, number>;
  narrow?: boolean;
  label?: string;
}

export function ShelfStrip({
  shelves,
  current,
  onSelect,
  counts,
  narrow = false,
  label = "Shelves",
}: ShelfStripProps): ReactNode {
  return (
    <div
      className={styles.strip}
      role="tablist"
      aria-label={label}
      data-narrow={narrow ? "true" : "false"}
    >
      {shelves.map((entry: Shelf) => {
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
