// SPRINGBOARD POLICY (#712).
//
// THE SEAM. `tile-model.ts` answers "what does THIS app's tile say", one
// selector per app body, over `ReplicaRow`s. This module answers a different
// question that never touches a row: given the tiles, WHERE do they sit, WHICH
// of them have earned the grid, and what is the springboard as a whole doing.
// The first is per-app and grows with the app roster; the second is one page's
// layout law and does not.
//
// Pure — no React, no react-native, no replica imports at all. Every
// function here takes `TileData`/`TileBody` (or a `Pick` of them) and returns
// a decision, which is what makes them unit-testable without a renderer.
//
// FOR THE ENGINES. This is the module a future Home/springboard engine claims:
// the order table, the size table, the empty copy and the two grading
// predicates are the whole of Home's layout policy, and the desktop grid's
// twin (packages/client/src/react/shell/routes/homeTiles.ts) is the other half
// of the same law. Unifying them is a file move from here, not an excavation.

import type { TileBody, TileData } from "./tile-model";

// ──────────────────────────────────────────────────────────── size ──────

/**
 * Tile size class: `small` 1×1, `medium` 2×1, `large` 2×2 — 4 columns on
 * desktop, 2 here, where `large` FLATTENS to 2×1 (a 2×2 across half a phone is
 * a tile you scroll past rather than read).
 *
 * The class follows the app's BODY, not its importance: a mosaic needs area,
 * prose needs measure, a figure or a chip needs neither. Kept in step with
 * packages/client/src/react/shell/routes/homeTiles.ts, which carries the same
 * table for the desktop grid.
 */
export type TileSize = "small" | "medium" | "large";

/**
 * Springboard order, taken from the handoff's own tile list rather than from
 * the CATALOG's order.
 *
 * The catalog (`@centraid/design`'s `apps`) is the All-apps listing and is not
 * a statement about the grid; using it here put Notes in the corner and pushed
 * the mosaic to the third row, so the first thing the eye met on Home was a
 * paragraph. The mosaic is the only body that needs area to be itself, and
 * giving it the corner is what makes the grid read as a page with a subject
 * instead of a launcher with a picture in it.
 *
 * Kept in step with packages/client/src/react/shell/routes/homeTiles.ts's
 * `HOME_TILE_ORDER`, the same way `TILE_SIZE` below is: the two clients must
 * not disagree about where an app sits.
 *
 * Freshness still decides what is IN a tile — it just does not decide where
 * the tile sits. A member who learns where Tally is has to find it there again.
 */
export const SPRINGBOARD_ORDER: readonly string[] = [
  "photos",
  "docs",
  "notes",
  "agenda",
  "tasks",
  "people",
  "tally",
  "locker",
];

const TILE_SIZE: Record<string, TileSize> = {
  agenda: "small",
  docs: "medium",
  // Notes' body IS the Docs preview body — a title over compact prose — and
  // the size class follows the body.
  notes: "medium",
  locker: "small",
  people: "small",
  photos: "large",
  tally: "small",
  tasks: "small",
};

/** An app with no first-party tile (a gateway app) takes the 1×1. */
export function tileSize(appId: string): TileSize {
  return TILE_SIZE[appId] ?? "small";
}

/** Whether the tile takes a FULL-WIDTH slot on the two-column mobile grid —
 *  true for both `medium` and the flattened `large`. */
export function isWideTile(appId: string): boolean {
  return tileSize(appId) !== "small";
}

// ───────────────────────────────────────────────────────────── copy ──────

/**
 * What to do when an app holds nothing yet — one imperative line per app.
 *
 * With the grid GRADED (see `tileEarnsGrid`) an empty app is normally a first
 * move rather than a tile, so this is the defensive body for the one case that
 * survives: a tile that earned the grid while loading and then settled with
 * nothing. It is deliberately what-to-DO rather than what-is-missing ("no
 * photos") — a quiet tile is an invitation, not a failure.
 */
export const TILE_EMPTY_COPY: Record<string, string> = {
  agenda: "Put something on the calendar",
  docs: "Add your first document",
  locker: "Unlock to see your items",
  notes: "Write your first note",
  people: "Add someone you know",
  photos: "Back up your first photo",
  tally: "Log your first expense",
  tasks: "Capture the next thing to do",
};

// ────────────────────────────────────────────────────────────── grading ───

/**
 * Whether this tile has EARNED a place on the grid.
 *
 * "A vault fills up gradually, so Home is graded, not binary" — a tile earns
 * the grid by having something to show, and everything else becomes a first
 * move under it. This replaces the all-or-nothing rule that put eight tiles on
 * screen the moment one note existed, seven of them apologising.
 *
 * Three answers, and each is a different kind of "yes":
 *
 *  - `content` — it has something. The obvious case.
 *  - `loading` — it may. A read in flight holds its slot at full geometry with
 *    a static skeleton, because demoting a tile to a first move and promoting
 *    it back a beat later is a relayout the member watches happen.
 *  - `locker` — its body is a STATE, not a query result. A locked shelf always
 *    has something true to say ("Locked") without previewing anything, so it is
 *    never an empty tile and never an invitation to fill it.
 *
 * `empty` and `unknown` do not earn it. `unknown` is the honest one: a tile
 * with no replica, no grant or a failed read cannot claim content, and putting
 * it on the grid would show a body we cannot stand behind.
 */
export function tileEarnsGrid(
  tile: Pick<TileData, "status"> & { body: Pick<TileBody, "kind"> }
): boolean {
  if (tile.body.kind === "locker") return true;
  return tile.status === "content" || tile.status === "loading";
}

/**
 * How many things the vault holds, for the status line.
 *
 * Sums only counts a read actually returned. A withheld count (Locker) is
 * omitted rather than treated as zero, and a capped count contributes its
 * ceiling — which is why the status line says "at least" when anything capped
 * (see `HomeStatusLine`). The one number on Home that claims to describe the
 * whole vault has to be assembled out of numbers that are each true.
 */
export function countThings(tiles: Iterable<TileData>): {
  total: number;
  capped: boolean;
  settled: boolean;
} {
  let total = 0;
  let capped = false;
  let settled = true;
  for (const tile of tiles) {
    if (tile.status === "loading") settled = false;
    if (tile.count === undefined) continue;
    total += tile.count;
    if (tile.countCapped) capped = true;
  }
  return { capped, settled, total };
}

// ──────────────────────────────────────────────────────────── first run ───

export type SpringboardState = "loading" | "first-run" | "content";

/**
 * Which treatment the springboard renders.
 *
 * - Any tile with content → the grid. One app having something is enough.
 * - Otherwise any tile still loading → loading. Day one is a claim about the
 *   vault, and an unsettled read has not earned it.
 * - Otherwise any tile unknown (no replica, no grant, a failed read) → the
 *   grid, with those tiles empty. We do not know the vault is empty, so we do
 *   not say so; the grid degrades honestly where the first-run copy would lie.
 * - Otherwise every tile settled and empty → first run.
 *
 * Tiles whose content is structurally unreadable from Home (Locker) report
 * `unknown` and therefore never vote the vault empty on their own — but they
 * also must not veto a genuine first run, so `unknown` only wins when nothing
 * is loading and nothing has content. That is exactly the no-replica case.
 */
export function springboardState(
  tiles: readonly Pick<TileData, "status">[]
): SpringboardState {
  if (tiles.length === 0) return "loading";
  if (tiles.some((tile) => tile.status === "content")) return "content";
  if (tiles.some((tile) => tile.status === "loading")) return "loading";
  const readable = tiles.filter((tile) => tile.status !== "unknown");
  if (readable.length === 0) return "content";
  return "first-run";
}
