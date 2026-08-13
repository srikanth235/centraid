// The shelf strip (Docs spec §1.7): six tabs under the frame's app bar —
// All · Folders · Recently changed · Starred · Coming due · Trash.
//
// The current tab is carried by a 2px INK bar plus 500 weight — not a fill,
// and never the app's hue. Docs' teal is a mark and a content accent; it never
// lands on a control, so the strip reads the same in both themes.
//
// ON THE COMPACT FORM FACTOR WITH THE APP BAND IT IS NOT RENDERED (§1.7): the
// band carries the same six destinations, and drawing both would put Trash in
// a horizontal strip that scrolls out of sight while the band says the same
// thing better. `bandOwned` is the app's own answer to "did my band claim get
// honoured", so the strip disappears for exactly the surface that replaced it.
//
// This replaces the sidebar's `SmartNav` (All / Recent / Starred). Two
// navigations for one set of shelves is what the restructure retires: the
// strip is the one that also carries Folders, Coming due and Trash, and it
// sits where the member is already looking.
import { DSHELVES, stripShelf } from "../shelves.ts";
import type { Shelf, ShelfId } from "../shelves.ts";

import styles from "./ShelfStrip.module.css";

export function ShelfStrip({
  shelf,
  onSelect,
  counts,
  narrow = false,
}: {
  /** The current shelf. A folder's own id lights **Folders**, because that is
   *  where the member reached it from (`stripShelf`). */
  shelf: ShelfId;
  onSelect: (id: ShelfId) => void;
  /** Per-shelf counts, by shelf id. A shelf with nothing to count omits its
   *  entry rather than showing a zero it had to invent. */
  counts?: ReadonlyMap<string, number>;
  /** The compact form factor — 44px tabs instead of 38px. */
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
