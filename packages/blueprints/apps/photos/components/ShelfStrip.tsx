// The shelf strip (v4 handoff §5): eight tabs under the frame's app bar.
//
// The current tab is carried by a 2px INK bar plus 500 weight — not a fill,
// and never the app's hue. Photos' amber is a mark and a content accent; it
// never lands on a control (§18), so the strip reads the same in both themes
// and against any photograph behind it.
//
// ON THE PHONE WITH THE APP BAND IT IS NOT RENDERED (§3, §15): the band
// carries the shelves, and drawing both would put Duplicates and Trash in a
// horizontal strip that scrolls out of sight while the band says the same
// thing better. `bandOwned` is the app's own answer to "did my band claim get
// honoured", so the strip disappears for exactly the surface that replaced it.
//
// ALBUM DETAIL drops the strip entirely (§5) — the app bar carries the album's
// own title and count, and the toolbar row carries the way back.
import type { Shelf, ShelfId } from "../shelves.ts";
import { SHELVES } from "../shelves.ts";

import styles from "./ShelfStrip.module.css";

export function ShelfStrip({
  shelf,
  onSelect,
  counts,
  narrow = false,
}: {
  /** The current shelf. An album's own id lights no tab — the strip is not
   *  rendered in album detail at all. */
  shelf: ShelfId;
  onSelect: (id: ShelfId) => void;
  /** Per-shelf counts, by shelf id. A shelf with nothing to count omits its
   *  entry rather than showing a zero it had to invent. */
  counts?: ReadonlyMap<string, number>;
  /** The compact form factor — 44px tabs instead of 38px. */
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
        const count = entry.id === null ? undefined : counts?.get(entry.id);
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
            {count === undefined ? null : (
              <span className={styles.tabCount}>{count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
