// The memories strip's cards (v4 handoff §4.6). Pure over what the store
// already holds — no reads, no writes, no DOM — so the orchestrator hands it
// data and gets cards back.
//
// Album membership is computed against OWN-SCOPE assets only: an album id
// minted in one scope means nothing in another, and matching it over the
// merged list would let a colliding id pull a stranger's photograph into the
// member's album (issue #599).
//
// A TRIP CARD IS TITLED, not measured (issue #816). The vault's own hint is
// `"3-day trip"`, which is a fact about a calendar rather than a memory; the
// ladder in `trips.ts` turns it into "Weekend in South Lake Tahoe, CA" when the
// members carry a name worth printing, and leaves the hint alone when they do
// not. Same module titles the phone's Memories screen, so the two surfaces say
// the same sentence about the same trip.
import { resolveHomeKey, tripFacts } from "./trips.ts";
import type { TripMember } from "./trips.ts";
import type {
  Album,
  Asset,
  MemoryCard,
  MemoryMemberRow,
  MemoryRow,
} from "./types.ts";

/** At most six cards — the strip is a head, not a second timeline. */
const LIMIT = 6;

/**
 * One trip member, as `trips.ts` wants it: when it was taken, in whose zone,
 * and where. An asset with no place contributes neither a day vote nor a route
 * point and is still a photograph in the trip — see `TripMember`.
 */
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

/**
 * The home place, resolved over the WHOLE loaded library rather than one
 * trip's members: the modal place of a trip is where the member went, and
 * calling that home would read every away day as a day at home. The tagged
 * `kind = 'home'` place wins when there is one, which is the vault's own rule.
 */
function homeKeyOf(ownAssets: readonly Asset[]): string | null {
  const tagged = ownAssets.flatMap((asset) =>
    asset.place?.kind === "home" ? [asset.place.place_id] : []
  );
  return resolveHomeKey(ownAssets.map(tripMemberOf), tagged);
}

/**
 * Each album's live count and its cover's bytes, computed off the loaded
 * window. The Albums card grid and the memories strip both need this and must
 * never disagree about a cover or a count, which is why it is one function.
 */
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
  /** The member's own photographs, used only to resolve projected members. */
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
  // Computed once for the whole strip, not once per trip: it reads every loaded
  // asset, and a strip of six cards would otherwise walk the library six times.
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
      // A trip is titled through the ladder and carries its own route; every
      // other kind keeps exactly the contract it had.
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
