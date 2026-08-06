// How the springboard's tiles are laid into the two-column grid.
//
// Tile sizes are mixed on purpose — a mosaic needs area, prose needs measure, a
// figure needs neither (./tile-model#tileSize) — and a flex-wrap grid places
// them in whatever order it is given. That leaves a HOLE whenever a 1×1 is
// followed by a full-width tile: the small takes the leading half of a row, the
// wide tile cannot fit beside it, and the trailing half stays blank. On a
// seeded vault the page read Notes / People + hole / Photos / Locker + Tally /
// Tasks + hole / Docs / Agenda + hole — three blanks that look like tiles that
// failed to render.
//
// The fix is packing, not sizing: pull the next 1×1 FORWARD to sit beside a
// lone one, rather than letting a wide tile break the pair. Nothing is resized,
// nothing is dropped, and a tile only ever moves EARLIER than the position it
// would otherwise have taken.
//
// Two properties this has to keep, and both are the reason it is a pure
// function with a test rather than a rule inside a render:
//
//  · Deterministic. The same content must produce the same page on every
//    launch. A member who learns where Tally sits has to find it there again;
//    a grid that reshuffles is a grid you have to re-read.
//  · Order-preserving at the front. Pinned apps are lifted to the head of the
//    list by ./catalog#orderByPins BEFORE packing runs, and packing only ever
//    promotes a later small into a gap — it never demotes anything, so a pin
//    still wins.
//
// A lone small at the END is not a hole: there is simply nothing left to pair
// it with, and moving it would be a reshuffle for no gain. A hole in the MIDDLE
// is the bug.

/**
 * The mobile grid's column count.
 *
 * The brief's rule is a grid FIT — 4 above 1040px of content, 3 above 720, 2
 * below — and a phone is always the last of those. It is a parameter rather
 * than a constant so the rule below stays true of the wider grids too: smalls
 * are packed into runs of `columns`, whatever `columns` happens to be.
 */
export const MOBILE_COLUMNS = 2;

/**
 * Order tiles so no full-width tile ever leaves a gap beside a 1×1.
 *
 * Walks the list once. A wide tile is emitted as it comes. A small opens a run,
 * and the run is filled by pulling the next smalls forward out of the remaining
 * list until the row is full or no smalls are left — so the only tiles that
 * move are 1×1s, and they only ever move earlier.
 */
export function packTiles<T>(
  items: readonly T[],
  isWide: (item: T) => boolean,
  columns: number = MOBILE_COLUMNS
): T[] {
  const queue = [...items];
  const packed: T[] = [];
  while (queue.length > 0) {
    const next = queue.shift() as T;
    packed.push(next);
    if (isWide(next)) continue;
    // `next` opened a row of smalls. Fill the rest of that row from whatever
    // smalls remain, skipping over the wide tiles between them.
    for (let seat = 1; seat < columns; seat += 1) {
      const partner = queue.findIndex((item) => !isWide(item));
      if (partner < 0) break;
      packed.push(...queue.splice(partner, 1));
    }
  }
  return packed;
}
