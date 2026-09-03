import type { NavRailItem } from "../_shared/NavRail.tsx";
import { ALBUMS, DUPLICATES, FAVORITES, TRASH } from "./constants.ts";
import { PEOPLE, PLACES, SEARCH, countKey, personIdFrom } from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";

const LIBRARY_GROUP: readonly ShelfId[] = [null, FAVORITES];
const COLLECTIONS_GROUP: readonly ShelfId[] = [ALBUMS, PLACES, PEOPLE];
const STATES_GROUP: readonly ShelfId[] = [DUPLICATES, TRASH];

const LABELS: ReadonlyMap<ShelfId, string> = new Map<ShelfId, string>([
  [null, "Library"],
  [FAVORITES, "Favorites"],
  [ALBUMS, "Albums"],
  [PLACES, "Places"],
  [PEOPLE, "People"],
  [DUPLICATES, "Duplicates"],
  [TRASH, "Trash"],
]);

export function railShelf(id: ShelfId): ShelfId | undefined {
  if (personIdFrom(id)) return PEOPLE;
  if (LABELS.has(id)) return id;
  if (typeof id === "string" && !id.startsWith("built-in:")) return ALBUMS;
  return undefined;
}

export function railDrawnOn(id: ShelfId): boolean {
  return id !== SEARCH;
}

export function photosNavRail({
  shelf,
  counts,
  onSelect,
}: {
  shelf: ShelfId;
  counts: ReadonlyMap<string, number>;
  onSelect: (id: ShelfId) => void;
}): NavRailItem[] {
  const current = railShelf(shelf);
  const row = (id: ShelfId): NavRailItem => {
    const count = counts.get(countKey(id));
    return {
      kind: "row",
      id: countKey(id),
      label: LABELS.get(id) ?? "",
      ...(count === undefined ? {} : { count }),
      ...(id === current ? { current: true } : {}),
      onSelect: () => onSelect(id),
    };
  };
  return [
    { kind: "head", label: "Library" },
    ...LIBRARY_GROUP.map(row),
    { kind: "head", label: "Collections" },
    ...COLLECTIONS_GROUP.map(row),
    { kind: "rule" },
    ...STATES_GROUP.map(row),
  ];
}
