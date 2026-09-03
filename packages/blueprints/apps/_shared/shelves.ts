export type ShelfId = string | null;

export interface Shelf {
  id: ShelfId;
  label: string;
  segment: string;
}

export interface BandDestination {
  id: string;
  label: string;
  icon?: string;
}

export function tokenFromShelf(prefix: string, id: ShelfId): string | null {
  return typeof id === "string" && id.startsWith(prefix)
    ? id.slice(prefix.length)
    : null;
}

export interface ShelfRouteConfig {
  route: string;
  routed: readonly Shelf[];
  band: readonly BandDestination[];
  rootBandId: string;
  dynamic?: {
    idPrefix: string;
    segmentPrefix: string;
    fallback: ShelfId;
    bandKey?: string;
  };
}

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
    countKey: (id: ShelfId): string => id ?? rootBandId,
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
