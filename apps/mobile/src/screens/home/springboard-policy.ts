// SPRINGBOARD POLICY (#712).
//
// THE SEAM: `tile-model.ts` answers "what does THIS app's tile say" over rows
// and grows with the app roster; this module never touches a row — it is one
// page's layout law (where tiles sit, which earned the grid, what the
// springboard as a whole is doing).
//
// KEEP IT PURE: no React, no react-native, no replica imports. Every function
// takes `TileData`/`TileBody` and returns a decision, which is what makes them
// testable without a renderer, and what would let a future springboard engine
// claim this file by moving it. Its desktop twin is
// `packages/client/src/react/shell/routes/homeTiles.ts`.

import type { TileBody, TileData } from "./tile-model";

// ──────────────────────────────────────────────────────────── size ──────

/**
 * `small` 1×1, `medium` 2×1, `large` 2×2 — 4 columns on desktop, 2 here, where
 * `large` FLATTENS to 2×1.
 *
 * The class follows the app's BODY, never its importance: a mosaic needs area,
 * prose needs measure, a figure or a chip needs neither. Kept in step with
 * `homeTiles.ts`, which carries the same table for desktop.
 */
export type TileSize = "small" | "medium" | "large";

/**
 * The handoff's tile list, NOT the catalog's order — the catalog is the
 * All-apps listing and says nothing about the grid. The mosaic takes the corner
 * because it is the one body that needs area to be itself.
 *
 * Freshness decides what is IN a tile; it must never decide where the tile
 * sits. Kept in step with `homeTiles.ts`'s `HOME_TILE_ORDER`.
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
  // Notes' body IS the Docs preview body, and the class follows the body.
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

/** Full-width on the two-column phone grid — `medium` and flattened `large`. */
export function isWideTile(appId: string): boolean {
  return tileSize(appId) !== "small";
}

// ───────────────────────────────────────────────────────────── copy ──────

/**
 * The defensive body for the one case grading leaves: a tile that earned the
 * grid while loading and settled with nothing.
 *
 * Every line is what-to-DO, never what-is-missing ("no photos") — a quiet tile
 * is an invitation, not a failure.
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
 * Three different kinds of yes:
 *
 *  - `content` — it has something.
 *  - `loading` — it may, and a read in flight holds its slot at full geometry:
 *    demoting and re-promoting a beat later is a relayout the member watches.
 *  - `locker` — its body is a STATE, not a query result, so it always has
 *    something true to say and is never an invitation to fill it.
 *
 * `empty` and `unknown` do not earn it. `unknown` is the honest one: no
 * replica, no grant or a failed read cannot claim content.
 */
export function tileEarnsGrid(
  tile: Pick<TileData, "status"> & { body: Pick<TileBody, "kind"> }
): boolean {
  if (tile.body.kind === "locker") return true;
  return tile.status === "content" || tile.status === "loading";
}

/**
 * Every tile `unknown` — no replica session, no grant, or every read failed.
 * The whole springboard's verdict, not one app's, and that is why it is a
 * separate question from `tileEarnsGrid`: demoting ONE unreadable tile beside
 * readable neighbours is right, demoting them ALL leaves a launcher with no
 * tiles. `springboardState` returns `content` here precisely so the screen does
 * not claim the vault is empty — and the grid it chose then rendered nothing
 * anyway (#905).
 */
export function everyTileUnreadable(
  tiles: readonly Pick<TileData, "status">[]
): boolean {
  return tiles.length > 0 && tiles.every((tile) => tile.status === "unknown");
}

/**
 * Which apps the grid shows, and which fall to first moves. It lived inline in
 * `Home.tsx` until #905 — which is why the defect above had no test at any
 * tier, a renderer being the only way to reach it. Generic over the item so
 * this file keeps its no-React promise; `LauncherItem` fits structurally.
 */
export function gridMembership<Item extends { meta: { id: string } }>(
  items: readonly Item[],
  tiles: ReadonlyMap<
    string,
    Pick<TileData, "status"> & { body: Pick<TileBody, "kind"> }
  >
): { earned: Item[]; idleIds: string[] } {
  const unreadable = everyTileUnreadable([...tiles.values()]);
  const earned: Item[] = [];
  const idleIds: string[] = [];
  for (const item of items) {
    const tile = tiles.get(item.meta.id);
    if (!tile || unreadable || tileEarnsGrid(tile)) earned.push(item);
    else idleIds.push(item.meta.id);
  }
  return { earned, idleIds };
}

/**
 * Sums ONLY counts a read actually returned: a withheld count (Locker) is
 * omitted, never treated as zero, and a capped count contributes its ceiling —
 * which is why `HomeStatusLine` says "at least" when anything capped. The one
 * number describing the whole vault is assembled from numbers each true.
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
 * - Any content → the grid; one app having something is enough.
 * - Else any loading → loading: day one is a claim about the vault, and an
 *   unsettled read has not earned it.
 * - Else all `unknown` → the grid with empty tiles. We do not KNOW the vault is
 *   empty, so we do not say so.
 * - Else every tile settled and empty → first run.
 *
 * Tiles structurally unreadable from Home report `unknown`, so they never vote
 * the vault empty — but they must not veto a genuine first run either, which is
 * why `unknown` only wins when nothing loads and nothing has content.
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
