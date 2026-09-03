import type { TileBody, TileData } from "./tile-model";

export type TileSize = "small" | "medium" | "large";

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
  notes: "medium",
  locker: "small",
  people: "small",
  photos: "large",
  tally: "small",
  tasks: "small",
};

export function tileSize(appId: string): TileSize {
  return TILE_SIZE[appId] ?? "small";
}

export function isWideTile(appId: string): boolean {
  return tileSize(appId) !== "small";
}

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

export function tileEarnsGrid(
  tile: Pick<TileData, "status"> & { body: Pick<TileBody, "kind"> }
): boolean {
  if (tile.body.kind === "locker") return true;
  return tile.status === "content" || tile.status === "loading";
}

export function everyTileUnreadable(
  tiles: readonly Pick<TileData, "status">[]
): boolean {
  return tiles.length > 0 && tiles.every((tile) => tile.status === "unknown");
}

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

export type SpringboardState = "loading" | "first-run" | "content";

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
