// PHOTOS' NAVIGATION RAIL — the rows, as a pure table (v16 §4).
//
// ```
// LIBRARY
//   Library            6,214
//   Favorites            128
// COLLECTIONS
//   Albums                14     · also current inside an album
//   Places                42
//   People                12
//   ──────────────────────────
//   Duplicates             6
//   Trash                 24
// ```
//
// TWO GROUPS, because a **shelf** is the library under a filter and a
// **collection** is its own set — the same grouping, the same tile and the
// same density control on one; a different object on the other. The strip
// flattened that distinction because a row of tabs has nowhere to put it.
//
// DUPLICATES AND TRASH SIT BELOW THE RULE. They are STATES of the library
// rather than places in it: everything in them is already in the library (or
// was), and a member goes to them to resolve something rather than to look at
// photographs.
//
// The reference's rail opens with **Sharing · 214** between Library and
// Favorites. This repo has no such shelf: there is no Sharing place, on the
// ruling that a share's place is the RECIPIENT'S vault (#726), so the row is
// absent here rather than pointing at a destination that does not exist. Every
// other row is a shelf in `shelves.ts` and is therefore reachable on touch
// through the band or the strip, which is what keeps the rail an arrangement
// of the app's destinations rather than a source of them.
//
// This file is a TABLE and a mapping; it renders nothing and reads no state.
// `_shared/NavRail.tsx` draws what it returns.
import type { NavRailItem } from "../_shared/NavRail.tsx";
import { ALBUMS, DUPLICATES, FAVORITES, TRASH } from "./constants.ts";
import { PEOPLE, PLACES, SEARCH, countKey, personIdFrom } from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";

/** The rail's rows, in order, as shelf ids. `null` is the Library shelf. */
const LIBRARY_GROUP: readonly ShelfId[] = [null, FAVORITES];
const COLLECTIONS_GROUP: readonly ShelfId[] = [ALBUMS, PLACES, PEOPLE];
/** Below the rule — states of the library, not places in it. */
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

/**
 * Which rail row a shelf lights.
 *
 * A sub-state lights the shelf it is a sub-state OF, because that is where the
 * member reached it from and the rail's job is to say where they are standing:
 *
 *   * an ALBUM's own detail view lights **Albums** (§4, and the definition of
 *     done says so outright — "inside an album, Albums is the current row");
 *   * ONE PERSON's timeline lights **People**, for exactly the same reason an
 *     album's does. `stripShelf` in Docs makes the same call for a folder.
 *
 * A shelf the rail does not list — Search, Storage, a tag or a memory — lights
 * nothing rather than lighting the row nearest to it. A rail that guessed
 * would be telling the member they are somewhere they are not.
 */
export function railShelf(id: ShelfId): ShelfId | undefined {
  if (personIdFrom(id)) return PEOPLE;
  if (LABELS.has(id)) return id;
  // Every remaining string id that is not a built-in is a COLLECTION id — an
  // album — and album detail is a sub-state of Albums.
  if (typeof id === "string" && !id.startsWith("built-in:")) return ALBUMS;
  return undefined;
}

/**
 * Does this shelf draw a rail at all?
 *
 * THE RULE IS THE DEFINITION OF DONE'S, not §4's list: "a rail on exactly the
 * routes that previously drew a strip, and no others". Read against this repo
 * that leaves one shelf out — SEARCH, which already drew no strip because it
 * reads as its own page rather than the timeline under a filter, and whose
 * field and states are the whole surface.
 *
 * §4 also names STORAGE, and this deliberately does not follow it there. The
 * strip draws on Storage today, and Storage is the one shelf a member can
 * reach that the rail does not list: withdrawing both would leave a desk seat
 * standing on a page with no way back into the library except the frame's own
 * stem. A rail with nothing current is the honest state — the member is
 * somewhere the rail does not name — and it is what the strip already does
 * there.
 *
 * ALBUM DETAIL IS DRAWN, though the strip is replaced by the album's own bar
 * there rather than withdrawn. §4's list of no-rail routes does not name it,
 * and the definition of done requires **Albums** to be the current row while
 * you are inside one, which is only sayable if the rail is drawn.
 *
 * The remaining routes §4 names — read-only, permission, importing, picker and
 * system — are seat states and overlays rather than shelves, and the caller
 * gates on them directly.
 */
export function railDrawnOn(id: ShelfId): boolean {
  return id !== SEARCH;
}

/**
 * The rail, built from the shelf tables and ONE counts map — the same map the
 * More sheet reads (`app-root.tsx` `shelfCounts`), so a count here can never
 * disagree with the count for the same shelf anywhere else. A shelf whose
 * count is not in the map draws no number rather than a zero it invented.
 */
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
