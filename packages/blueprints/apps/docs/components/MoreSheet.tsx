import type { ShelfId } from "../shelves.ts";
// The compact band's SIXTH SLOT (Docs spec §1.5) — "More in Docs", which is
// what `InlineBandClaim.onMore` is for.
//
// The band is capped at four destinations plus More, and Docs has six shelves
// and three sheet destinations. More is where the ones off the band live.
//
// IT IS A SHEET, NOT A SECOND BAND: it opens on a member's tap, it dismisses
// on Esc or on the scrim, it claims no destinations of its own and it never
// calls `claimBand`. Opaque paper and a hairline, never blur and never a
// shadow — the same rule the bands hold.
//
// ROWS WHOSE DESTINATION DOES NOT EXIST YET ARE NOT DRAWN. `view-copy.ts`
// carries all eight of §1.5's rows so the copy is decided once; `live` says
// which of them this app can actually reach today. A sheet that offered a
// place the app cannot open would be a dead end, which is the one thing a
// navigation surface may never be.
import { MORE_FOOTER, MORE_ROWS, MORE_TITLE } from "../view-copy.ts";

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
      {/* §1.5's own closing sentence. It is the sheet's whole explanation of
          where the member is and how to leave, so it is not decoration. */}
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
