// LOADING IS A SHAPE, NOT AN ABSENCE (v4 handoff §14, README §14, proto
// 3993-4033).
//
// "A tile knows its shape and its colour before its bytes arrive — `--skel` at
// the exact geometry the photograph will occupy, so nothing reflows." That
// sentence is about a tile whose RECORD is already here. This component is
// about the moment before even the records are: the first read is in flight,
// the app knows nothing, and the two things it must not do are (a) claim the
// library is empty and (b) collapse the grid to nothing and then reflow the
// whole page when 6,214 rows land.
//
// So it paints the grid's own geometry: the SAME packer the timeline uses
// (`justify`, layout.ts), at the SAME target row height for the member's
// current rung, with the SAME 2px gutter — so the skeleton rows and the real
// rows occupy the same boxes and the transition is a repaint, not a relayout.
// The rail's 14px column is reserved by the same padding rule for the same
// reason: a column that appeared once data landed would move every tile.
//
// The aspect ratios are a FIXED sequence, never random: a re-render must paint
// the identical skeleton, and a "shuffled" one would read as movement in a
// product whose loading state is explicitly static (DESIGN.md — determinate
// only, no shimmer).
//
// It says nothing in words. The one status line owns the sentence (§3, §14),
// including the determinate count while an import runs; a second "Loading…"
// inside the pane would be this app drawing chrome it does not own.
import { cls } from "../format.ts";
import { justify } from "../layout.ts";
import type { Asset } from "../types.ts";

import styles from "./LoadingGrid.module.css";

/**
 * The shapes a camera roll actually holds — landscape, portrait, a square, a
 * panorama — so the packed rows look like a timeline rather than a filmstrip
 * of identical boxes. Repeated in order; see the header on why it is fixed.
 */
const SHAPES: readonly (readonly [number, number])[] = [
  [4, 3],
  [3, 4],
  [3, 2],
  [1, 1],
  [16, 9],
  [2, 3],
  [5, 4],
  [3, 2],
  [4, 5],
  [16, 10],
];

/** How many rows of skeleton to paint. Enough to reach past the fold on a
 *  desktop pane at any rung; fewer would leave a bright empty band under the
 *  skeleton, which reads as "this is all there is". */
const ROWS = 6;

/**
 * Placeholder records for the packer. These are NEVER rendered as photographs
 * and carry no id a caller could mistake for an asset: `justify` reads only
 * `width`/`height`, and the tiles below read nothing at all.
 */
function shapes(count: number): Asset[] {
  return Array.from({ length: count }, (_, i) => {
    const [w, h] = SHAPES[i % SHAPES.length]!;
    return { asset_id: `skeleton-${i}`, width: w * 100, height: h * 100 };
  }) as Asset[];
}

export interface LoadingGridProps {
  /** The packer's budget — the pane minus the rail on desktop, exactly as the
   *  timeline computes it, so the two agree to the pixel. */
  containerWidth: number;
  /** The member's rung, resolved to this surface's row height (§4.2). */
  targetHeight: number;
  /** The compact form factor: the rail overlays instead of taking a column. */
  phone: boolean;
}

export function LoadingGrid({
  containerWidth,
  targetHeight,
  phone,
}: LoadingGridProps) {
  // Enough tiles that the packer closes ROWS full rows at this width: a row
  // holds roughly `containerWidth / targetHeight` tiles at an average aspect
  // ratio near 1.2, and over-supplying costs nothing — the trailing partial
  // row is simply not drawn (see `slice` below).
  const perRow = Math.max(1, Math.round(containerWidth / (targetHeight * 1.2)));
  const rows = justify(
    shapes(perRow * ROWS),
    containerWidth,
    targetHeight
  ).slice(0, ROWS);

  return (
    // `aria-busy` on the region and `aria-hidden` on the boxes: a screen
    // reader is told the library is still loading ONCE, rather than being read
    // a wall of meaningless empty spans.
    <div className={styles.grid} aria-busy="true">
      <div
        className={cls(styles.stream, phone ? styles.streamPhone : null)}
        aria-hidden="true"
      >
        {rows.map((tiles, row) => (
          <div className={styles.row} key={`skeleton-row-${row}`}>
            {tiles.map((tile, i) => (
              <span
                className={styles.tile}
                key={`skeleton-${row}-${i}`}
                style={{ width: `${tile.width}px`, height: `${tile.height}px` }}
              />
            ))}
          </div>
        ))}
      </div>
      {/* The rail's 14px COLUMN is reserved by `.stream`'s padding, exactly as
          the timeline reserves it, so the grid does not shift sideways when
          the real rail arrives. The rail itself is not drawn: its ticks are
          months, months are the one thing not known yet, and inventing them
          would be a worse lie than an empty column (ScrubRail renders nothing
          for an empty tick list for the same reason). */}
    </div>
  );
}
