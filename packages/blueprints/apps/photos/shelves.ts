// The seven shelves, the compact band's destinations, and the three questions
// every surface asks about a shelf (v4 handoff §5, §3.1, §16; the Sharing
// place does not exist here — a share's place is the recipient's vault, #726).
//
// The structure — id model, route round trip, band tab — is
// `_shared/shelves.ts`. This file is Photos' TABLES.
import { createShelfRoutes, tokenFromShelf } from "../_shared/shelves.ts";
import type { BandDestination, Shelf, ShelfId } from "../_shared/shelves.ts";
import type { SelectionShelfKind } from "./components/SelectionBar.tsx";
import { ALBUMS, DUPLICATES, FAVORITES, TRASH } from "./constants.ts";

export type { Shelf, ShelfId } from "../_shared/shelves.ts";

// The shelves that had no built-in id before v4. Same one-slot trick as the
// existing built-ins: the prefix can never collide with a collection id,
// which is an opaque token and never carries a colon.
export const PLACES = "built-in:places";
export const PEOPLE = "built-in:people";
/** Search is a shelf (§9), reached from the band and the frame — not a field
 *  in a header the app draws for itself. */
export const SEARCH = "built-in:search";
/**
 * Storage (§12) — what the bytes cost and where they are. It is NOT another
 * strip tab: §5 fixes the strip, and §15 puts Storage in the compact band's More sheet
 * beside Import. It has a route segment like Search does, so it is a
 * destination the app can reach and describe rather than a panel bolted onto
 * another shelf.
 */
export const STORAGE = "built-in:storage";

/** One confirmed person's own sub-state of the People shelf (§5): the same
 *  timeline under a filter, exactly as album detail is. */
const PERSON_PREFIX = "person:";

/** The shelf id for one person, from their party id. */
export function personShelf(partyId: string): string {
  return `${PERSON_PREFIX}${partyId}`;
}

/** The party id behind a person shelf, or null for any other shelf. */
export function personIdFrom(id: ShelfId): string | null {
  return tokenFromShelf(PERSON_PREFIX, id);
}

/** The strip, in order (§5). Search is deliberately absent: it is a shelf the
 *  band and the frame reach, not a ninth tab. */
export const SHELVES: readonly Shelf[] = [
  { id: null, label: "Library", segment: "" },
  { id: FAVORITES, label: "Favorites", segment: "favorites" },
  { id: ALBUMS, label: "Albums", segment: "albums" },
  { id: PLACES, label: "Places", segment: "places" },
  { id: PEOPLE, label: "People", segment: "people" },
  { id: DUPLICATES, label: "Duplicates", segment: "duplicates" },
  { id: TRASH, label: "Trash", segment: "trash" },
];

/** Every shelf that has a route segment, including the ones off the strip. */
const ROUTED: readonly Shelf[] = [
  ...SHELVES,
  { id: SEARCH, label: "Search", segment: "search" },
  { id: STORAGE, label: "Storage", segment: "storage" },
];

/**
 * The compact band Photos claims (§3.1): five destinations, exactly. The frame
 * supplies the home capsule outside this group and enforces the cap; the app
 * only says what its own tabs are.
 */
export const BAND_DESTINATIONS: readonly BandDestination[] = [
  { id: "library", label: "Library", icon: "Image" },
  { id: "albums", label: "Albums", icon: "album" },
  { id: "people", label: "People", icon: "person" },
  { id: "search", label: "Search", icon: "Search" },
];

/**
 * The compact band's sixth slot — the app's OWN overflow sheet (§15). It
 * carries exactly what the five destinations left behind, in the strip's own
 * order: Favorites, Places, Duplicates, Trash, then Storage. Import
 * is not here — it is the app bar's filled action on every shelf that can
 * take one, and a second way in would be a second control for one verb.
 */
export const MORE_DESTINATIONS: readonly Shelf[] = [
  ...SHELVES.filter(
    (shelf) =>
      shelf.id !== null &&
      !BAND_DESTINATIONS.some((dest) => dest.id === shelf.segment)
  ),
  { id: STORAGE, label: "Storage", segment: "storage" },
];

/** The route round trip and the band's active tab (`_shared/shelves.ts`):
 *  `photos` or `photos/<sub>`, one destination either way (§16). */
export const {
  countKey,
  shelfFromSegment,
  shelfRoute,
  shelfFromRoute,
  bandActiveId,
} = createShelfRoutes({
  route: "photos",
  routed: ROUTED,
  band: BAND_DESTINATIONS,
  rootBandId: "library",
});

/** The shelves that paint something OTHER than the justified timeline: a card
 *  grid, a map, circular cards, clusters, a query box. */
const NON_TIMELINE: ReadonlySet<string> = new Set([
  ALBUMS,
  PLACES,
  PEOPLE,
  DUPLICATES,
  SEARCH,
  STORAGE,
]);

/**
 * Does this shelf paint the justified timeline? An album's own detail view
 * does too — its id is a collection id, which is in neither table — and so
 * does ONE person's sub-state of the People shelf, which is the same timeline
 * under a filter (§5). The People shelf itself is the card grid, so it stays
 * out.
 */
export function showsTimeline(id: ShelfId): boolean {
  return id === null || !NON_TIMELINE.has(id);
}

/**
 * Does this shelf PACK TILES? Every timeline shelf does, and so does Places —
 * its sections are justified rows of the same tile under a place filter (§5),
 * which is why it is not a card grid like Albums. It is a separate question
 * from `showsTimeline`, which is about the month/day scroller.
 */
export function packsTiles(id: ShelfId): boolean {
  return showsTimeline(id) || id === PLACES;
}

/** Tile size is a member preference, but it only means something where tiles
 *  are packed — a stepper over the Albums card grid is chrome (§3). */
export function showsTileSize(id: ShelfId): boolean {
  return packsTiles(id);
}

/**
 * May `Select` be entered here? Every timeline shelf, Trash included (§6):
 * the bar's fifth action becomes **Restore** there (components/SelectionBar.tsx
 * derives the swap from the shelf) rather than Trash losing selection
 * altogether.
 */
export function allowsSelection(id: ShelfId): boolean {
  return packsTiles(id);
}

/**
 * Which of the selection bar's shelf swaps applies (§6): Trash's fifth action
 * becomes Restore. Every other shelf — including album detail, whose id is a
 * collection id and matches nothing — carries the base order untouched
 * (`normal`).
 */
export function shelfKindFor(id: ShelfId): SelectionShelfKind {
  return id === TRASH ? "trash" : "normal";
}
