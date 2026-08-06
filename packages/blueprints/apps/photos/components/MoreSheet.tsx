// The compact band's SIXTH SLOT (v4 handoff §3.1, §15) — the app's own
// overflow sheet, which is what `InlineBandClaim.onMore` is for.
//
// The band is capped at five destinations plus More, and Photos has eight
// shelves. More is where the other three live, plus Storage: Sharing,
// Favorites, Places, Duplicates, Trash, Storage (shelves.ts
// `MORE_DESTINATIONS`). Import is deliberately absent — it is the app bar's
// filled action on every shelf that can take one, and a second way in would be
// two controls for one verb.
//
// It is a SHEET, not a second band: it opens on a member's tap, it dismisses
// on Esc or on the scrim, it claims no destinations of its own and it never
// calls `claimBand`. Opaque paper and a hairline, never blur and never a
// shadow — the same rule the bands hold, for the same reason (§3.1: the
// backdrop is unpredictable photographs).
import { MORE_DESTINATIONS } from "../shelves.ts";
import type { ShelfId } from "../shelves.ts";

import styles from "./MoreSheet.module.css";

export function MoreSheet({
  shelf,
  counts,
  onSelect,
  onClose,
}: {
  /** Which destination is current, so the sheet does not lie about where the
   *  member already is. */
  shelf: ShelfId;
  /** Per-shelf counts, by shelf id. A destination with nothing to count omits
   *  its entry rather than showing a zero it had to invent. */
  counts?: ReadonlyMap<string, number>;
  onSelect: (id: ShelfId) => void;
  onClose: () => void;
}) {
  return (
    // A native <dialog> with `open` — never `showModal()`. The sheet sits
    // inside the app pane (which is one pane inside the shell), and a modal
    // dialog would take the top layer over the frame's own chrome, which an
    // app may not do.
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
