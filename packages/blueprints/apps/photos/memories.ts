// The memories strip's cards (v4 handoff §4.6). Pure over what the store
// already holds — no reads, no writes, no DOM — so the orchestrator hands it
// data and gets cards back.
//
// Album membership is computed against OWN-SCOPE assets only: an album id
// minted in one scope means nothing in another, and matching it over the
// merged list would let a colliding id pull a stranger's photograph into the
// member's album (issue #599).
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
      const title =
        memory.kind === "on-this-day"
          ? "On this day"
          : (memory.title_hint ??
            (memory.kind === "trip" ? "A trip" : "Similar photographs"));
      return {
        key: memory.memory_id,
        title,
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
