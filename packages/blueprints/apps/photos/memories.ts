import { resolveHomeKey, tripFacts } from "./trips.ts";
import type { TripMember } from "./trips.ts";
import type {
  Album,
  Asset,
  MemoryCard,
  MemoryMemberRow,
  MemoryRow,
} from "./types.ts";

const LIMIT = 6;

function tripMemberOf(asset: Asset): TripMember {
  const offset = asset.tz_offset_min;
  return {
    capturedAt: asset.taken_at ?? asset.captured_at ?? null,
    tzOffsetMin: typeof offset === "number" ? offset : null,
    place: asset.place
      ? {
          key: asset.place.place_id,
          name: asset.place.name,
          gazetteer: asset.place.gazetteer,
          lat: asset.place.lat,
          lng: asset.place.lng,
        }
      : null,
  };
}

function homeKeyOf(ownAssets: readonly Asset[]): string | null {
  const tagged = ownAssets.flatMap((asset) =>
    asset.place?.kind === "home" ? [asset.place.place_id] : []
  );
  return resolveHomeKey(ownAssets.map(tripMemberOf), tagged);
}

export function enrichAlbums(
  albums: readonly Album[],
  ownAssets: readonly Asset[]
): Album[] {
  return albums.map((album) => {
    const members = ownAssets.filter((a) =>
      (a.album_ids ?? []).includes(album.album_id)
    );
    const cover =
      members.find(
        (member) =>
          !!album.cover_content_id &&
          member.content_id === album.cover_content_id
      ) ?? members[0];
    return {
      ...album,
      count: members.length,
      coverUri: cover?.thumb_uri ?? cover?.content_uri ?? null,
    };
  });
}

export function buildMemories({
  ownAssets,
  memories,
  memoryMembers,
  onOpen,
}: {
  ownAssets: readonly Asset[];
  memories: readonly MemoryRow[];
  memoryMembers: readonly MemoryMemberRow[];
  onOpen: (shelf: string) => void;
}): MemoryCard[] {
  const assetById = new Map(ownAssets.map((asset) => [asset.asset_id, asset]));
  const membersByMemory = new Map<string, MemoryMemberRow[]>();
  for (const member of memoryMembers) {
    const list = membersByMemory.get(member.memory_id);
    if (list) list.push(member);
    else membersByMemory.set(member.memory_id, [member]);
  }
  const homeKey = memories.some((memory) => memory.kind === "trip")
    ? homeKeyOf(ownAssets)
    : null;
  return memories
    .map((memory): MemoryCard | null => {
      const members = [...(membersByMemory.get(memory.memory_id) ?? [])]
        .sort((a, b) => a.ordinal - b.ordinal)
        .flatMap((member) => {
          const asset = assetById.get(member.asset_id);
          return asset ? [asset] : [];
        });
      const cover = members[0];
      if (!cover) return null;
      const trip =
        memory.kind === "trip"
          ? tripFacts({
              members: members.map(tripMemberOf),
              homePlaceKey: homeKey,
              titleHint: memory.title_hint,
              placeKey: memory.place_id,
            })
          : null;
      const title =
        memory.kind === "on-this-day"
          ? "On this day"
          : (trip?.title ??
            memory.title_hint ??
            (memory.kind === "trip" ? "A trip" : "Similar photographs"));
      const route = trip?.route ?? [];
      return {
        key: memory.memory_id,
        title,
        ...(route.length > 0 ? { route } : {}),
        sub: `${members.length} photograph${members.length === 1 ? "" : "s"}`,
        coverUri: cover.thumb_uri ?? cover.content_uri ?? null,
        coverScopeId: cover.scope_id,
        newestAt:
          memory.ended_at ?? memory.started_at ?? memory.computed_at ?? "",
        onOpen: () => onOpen(`memory:${memory.memory_id}`),
      };
    })
    .filter((c): c is MemoryCard => c !== null)
    .sort((a, b) => String(b.newestAt).localeCompare(String(a.newestAt)))
    .slice(0, LIMIT);
}
