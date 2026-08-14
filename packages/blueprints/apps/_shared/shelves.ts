// The shelf model both blueprint apps navigate by. Photos' seven shelves and
// Docs' six are the SAME structure under two vocabularies: per-app files own
// the TABLES (which shelves exist, what they are called, what each draws) and
// this file owns the ROUND TRIP.
//
// A SHELF IS THE SAME SET UNDER A FILTER — same rows or tiles, same grouping,
// same selection — so it is a value, not a component: the strip, the band, the
// app bar and the breadcrumb read the SAME record and cannot disagree about
// what "Trash" is. And ONE DESTINATION: `<app>` and `<app>/<sub>` are one route,
// so `createShelfRoutes` keeps the round trip a testable pure function even
// while the shell has no per-app sub-route to push into yet.

/** `null` is the app's own root shelf: the app's route with no segment. */
export type ShelfId = string | null;

export interface Shelf {
  id: ShelfId;
  /** The tab's caption. Final copy — each app's spec strings, verbatim. */
  label: string;
  /** The `<app>/<sub>` segment, or `""` for the root. */
  segment: string;
}

/** One tab of the compact band. The frame supplies the home capsule outside the
 *  group and enforces the cap; an app names only its own tabs. */
export interface BandDestination {
  id: string;
  label: string;
  /** The shared registry key for the tab's supporting glyph. */
  icon?: string;
}

/**
 * The token behind a dynamic shelf id — a person's own timeline (`person:p3`),
 * a folder's own contents (`folder:f7`) — or null for any other shelf. The
 * prefix can never collide with a party or folder id, which is an opaque token
 * carrying no colon; that one-slot trick is why these ids share `ShelfId` with
 * the built-ins.
 */
export function tokenFromShelf(prefix: string, id: ShelfId): string | null {
  return typeof id === "string" && id.startsWith(prefix)
    ? id.slice(prefix.length)
    : null;
}

export interface ShelfRouteConfig {
  /** The app's route id — `photos`, `docs`. Never a prototype screen key. */
  route: string;
  /** Every shelf with a route segment, including the ones off the strip. */
  routed: readonly Shelf[];
  band: readonly BandDestination[];
  /** The band's id for the root shelf, whose segment is empty (`library`,
   *  `list`). Accepted as a segment synonym too, so a band id round-trips. */
  rootBandId: string;
  /** A shelf family whose id carries an opaque token (`folder:f7`) and whose
   *  route carries it as a segment (`folder/f7`). `fallback` is where a segment
   *  with no token lands; `bandKey` is the band tab one member lights (a folder
   *  lights **Folders**, where the member reached it from). */
  dynamic?: {
    idPrefix: string;
    segmentPrefix: string;
    fallback: ShelfId;
    bandKey?: string;
  };
}

/**
 * The route round trip for one app's shelf tables. An id the tables do not
 * carry — an album id, a collection token — has no segment, so it routes to the
 * app's root and lights the root's band tab rather than the wrong one.
 */
export function createShelfRoutes(config: ShelfRouteConfig) {
  const { route, routed, band, rootBandId, dynamic } = config;

  const shelfSegment = (id: ShelfId): string => {
    const token = dynamic ? tokenFromShelf(dynamic.idPrefix, id) : null;
    if (dynamic && token) return `${dynamic.segmentPrefix}${token}`;
    return routed.find((shelf) => shelf.id === id)?.segment ?? "";
  };

  const shelfFromSegment = (segment: string): ShelfId => {
    if (segment === "" || segment === rootBandId) return null;
    if (dynamic && segment.startsWith(dynamic.segmentPrefix)) {
      const token = segment.slice(dynamic.segmentPrefix.length);
      return token ? `${dynamic.idPrefix}${token}` : dynamic.fallback;
    }
    return routed.find((shelf) => shelf.segment === segment)?.id ?? null;
  };

  return {
    shelfFromSegment,
    shelfSegment,
    shelfRoute: (id: ShelfId): string => {
      const segment = shelfSegment(id);
      return segment ? `${route}/${segment}` : route;
    },
    shelfFromRoute: (path: string): ShelfId => {
      const [head, ...rest] = path.split("/");
      return head === route ? shelfFromSegment(rest.join("/")) : null;
    },
    bandActiveId: (id: ShelfId): string | undefined => {
      const dynamicKey =
        dynamic && tokenFromShelf(dynamic.idPrefix, id)
          ? dynamic.bandKey
          : undefined;
      const key = dynamicKey ?? shelfSegment(id);
      const active = key === "" ? rootBandId : key;
      return band.some((dest) => dest.id === active) ? active : undefined;
    },
  };
}
