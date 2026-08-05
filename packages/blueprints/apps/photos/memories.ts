// The memories strip's cards (v4 handoff §4.6). Pure over what the store
// already holds — no reads, no writes, no DOM — so the orchestrator hands it
// data and gets cards back.
//
// Album membership is computed against OWN-SCOPE assets only: an album id
// minted in one scope means nothing in another, and matching it over the
// merged list would let a colliding id pull a stranger's photograph into the
// member's album (issue #599).
import type { Album, Asset, MemoryCard } from "./types.ts";

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
  assets,
  ownAssets,
  albums,
  onOpen,
}: {
  /** The merged, filtered timeline the member is looking at. */
  assets: readonly Asset[];
  /** The member's own photographs, for album membership. */
  ownAssets: readonly Asset[];
  albums: readonly Album[];
  onOpen: (shelf: string) => void;
}): MemoryCard[] {
  const cards: MemoryCard[] = [];
  const favorites = assets.filter((a) => a.favorite);
  if (favorites.length > 0) {
    const first = favorites[0]!;
    cards.push({
      key: "built-in:favorites",
      title: "Favorites",
      sub: `${favorites.length} photograph${favorites.length === 1 ? "" : "s"}`,
      coverUri: first.thumb_uri ?? first.content_uri ?? null,
      // The cover is one real asset's bytes; the card carries the scope they
      // must be fetched in (issue #599).
      coverScopeId: first.scope_id,
      newestAt: first.taken_at ?? "",
      onOpen: () => onOpen("built-in:favorites"),
    });
  }
  const albumCards = albums
    .map((album): MemoryCard | null => {
      const members = ownAssets.filter((a) =>
        (a.album_ids ?? []).includes(album.album_id)
      );
      if (members.length === 0) return null;
      const newest = members.reduce(
        (a, b) => (String(a.taken_at ?? "") > String(b.taken_at ?? "") ? a : b),
        members[0]!
      );
      return {
        key: album.album_id,
        title: album.title ?? "Album",
        sub: `${members.length} photograph${members.length === 1 ? "" : "s"}`,
        coverUri: newest.thumb_uri ?? newest.content_uri ?? null,
        coverScopeId: newest.scope_id,
        newestAt: newest.taken_at ?? "",
        onOpen: () => onOpen(album.album_id),
      };
    })
    .filter((c): c is MemoryCard => c !== null)
    .sort((a, b) => String(b.newestAt).localeCompare(String(a.newestAt)));
  return [...cards, ...albumCards].slice(0, LIMIT);
}
