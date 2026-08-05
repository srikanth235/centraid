// The eight shelves, the compact band's destinations, and the three questions
// every surface asks about a shelf (v4 handoff §5, §3.1, §16).
//
// A SHELF IS THE SAME TIMELINE UNDER A FILTER — same tile, same grouping, same
// tile-size control, same selection. That is why a shelf is a value here and
// not a component: the strip, the band, the app bar and the toolbar row all
// read the SAME record, so they cannot disagree about what "Trash" is.
//
// ONE DESTINATION. `photos` and `photos/<sub>` are one route (§16), so the
// frame routes to one app and the shelf is a segment inside it. `shelfRoute` /
// `shelfFromRoute` are that mapping, kept here rather than in the orchestrator
// so the round trip is a testable pure function even while the shell has no
// per-app sub-route to push into yet.
import type { SelectionShelfKind } from "./components/SelectionBar.tsx";
import { ALBUMS, DUPLICATES, FAVORITES, TRASH } from "./constants.ts";

// The four shelves that had no built-in id before v4. Same one-slot trick as
// the existing built-ins: the prefix can never collide with a collection id,
// which is an opaque token and never carries a colon.
export const SHARING = "built-in:sharing";
export const PLACES = "built-in:places";
export const PEOPLE = "built-in:people";
/** Search is a shelf (§9), reached from the band and the frame — not a field
 *  in a header the app draws for itself. */
export const SEARCH = "built-in:search";
/**
 * Storage (§12) — what the bytes cost and where they are. It is NOT a ninth
 * tab: §5 says eight, and §15 puts Storage in the compact band's More sheet
 * beside Import. It has a route segment like Search does, so it is a
 * destination the app can reach and describe rather than a panel bolted onto
 * another shelf.
 */
export const STORAGE = "built-in:storage";

/** One confirmed person's own sub-state of the People shelf (§5): the same
 *  timeline under a filter, exactly as album detail is. The prefix can never
 *  collide with a collection id, which carries no colon. */
const PERSON_PREFIX = "person:";

/** The shelf id for one person, from their party id. */
export function personShelf(partyId: string): string {
  return `${PERSON_PREFIX}${partyId}`;
}

/** The party id behind a person shelf, or null for any other shelf. */
export function personIdFrom(id: ShelfId): string | null {
  return typeof id === "string" && id.startsWith(PERSON_PREFIX)
    ? id.slice(PERSON_PREFIX.length)
    : null;
}

/** `null` is the Library shelf: the app's own root, with no segment. */
export type ShelfId = string | null;

export interface Shelf {
  id: ShelfId;
  /** The tab's caption. Final copy — the handoff's strings, verbatim. */
  label: string;
  /** The `photos/<sub>` segment, or `""` for the root. */
  segment: string;
}

/** The strip, in order (§5). Search is deliberately absent: it is a shelf the
 *  band and the frame reach, not a ninth tab. */
export const SHELVES: readonly Shelf[] = [
  { id: null, label: "Library", segment: "" },
  { id: SHARING, label: "Sharing", segment: "sharing" },
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
export const BAND_DESTINATIONS: readonly { id: string; label: string }[] = [
  { id: "library", label: "Library" },
  { id: "albums", label: "Albums" },
  { id: "people", label: "People" },
  { id: "search", label: "Search" },
];

/**
 * The compact band's sixth slot — the app's OWN overflow sheet (§15). It
 * carries exactly what the five destinations left behind, in the strip's own
 * order: Sharing, Favorites, Places, Duplicates, Trash, then Storage. Import
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

/** The band's ids are route segments, so one table serves both directions. */
export function shelfFromSegment(segment: string): ShelfId {
  return ROUTED.find((shelf) => shelf.segment === segment)?.id ?? null;
}

/** `photos` or `photos/<sub>` — one destination either way (§16). */
export function shelfRoute(id: ShelfId): string {
  const segment = ROUTED.find((shelf) => shelf.id === id)?.segment ?? "";
  return segment ? `photos/${segment}` : "photos";
}

export function shelfFromRoute(route: string): ShelfId {
  const [head, ...rest] = route.split("/");
  if (head !== "photos") return null;
  return shelfFromSegment(rest.join("/"));
}

/** The band's `activeId` for a shelf — the segment, or `library` at the root.
 *  A shelf with no band tab (Trash, say) lights none of them rather than
 *  lighting the wrong one. */
export function bandActiveId(id: ShelfId): string | undefined {
  const segment = ROUTED.find((shelf) => shelf.id === id)?.segment ?? "library";
  const key = segment === "" ? "library" : segment;
  return BAND_DESTINATIONS.some((dest) => dest.id === key) ? key : undefined;
}

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
 * derives the swap from the shelf, the same way it derives Sharing's
 * **Remove from Sharing** third action) rather than Trash losing selection
 * altogether. Trash used to be excluded here for exactly the reason the bar
 * now handles — widening this predicate is what turns it back on.
 */
export function allowsSelection(id: ShelfId): boolean {
  return packsTiles(id);
}

/**
 * Which of the selection bar's two shelf swaps applies (§6): Trash's fifth
 * action becomes Restore, Sharing's third becomes Remove from Sharing. Every
 * other shelf — including album detail, whose id is a collection id and
 * matches neither — carries the base order untouched (`normal`).
 */
export function shelfKindFor(id: ShelfId): SelectionShelfKind {
  if (id === TRASH) return "trash";
  if (id === SHARING) return "sharing";
  return "normal";
}
