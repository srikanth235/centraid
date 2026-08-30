/**
 * Photo search as a vault projection (#352): the in-vault FTS5 index matches
 * titles/captions on core.content_item. Only matched content ids' live assets
 * are read, never a table scan; trashed items fall out of the index.
 *
 * Row shape mirrors queries/library.js's `join()` output row-for-row so hits
 * render straight into the existing grid; album-name matching stays
 * client-side. Consent denial is a first-class outcome.
 */
import { readAssetJoins, readPlaces, srcOf } from "./_shared.ts";

interface RawHit {
  content_id: string;
}

interface RawAsset {
  asset_id: string;
  content_id: string;
  favorite?: unknown;
  captured_at?: string | null;
  place_id?: string | null;
}

interface RawContent {
  content_id: string;
  content_uri?: unknown;
  byte_size?: number | null;
  media_type?: string | null;
  title?: string | null;
  created_at?: string | null;
  deleted_at?: string | null;
}

interface RawEntry {
  target_id: string;
  collection_id: string;
}

interface RawCollection {
  collection_id: string;
  name?: string | null;
  cover_content_id?: string | null;
}

export default async function searchHandler({ input, ctx }: HandlerArgs) {
  const purpose = "dpv:ServiceProvision";
  const term = String(input?.term ?? "").trim();
  if (!term) return { assets: [] };
  try {
    const hits = await ctx.vault.search({
      entity: "core.content_item",
      query: term,
      limit: 300,
      purpose,
    });
    const contentIds = [
      ...new Set(
        ((hits.rows ?? []) as unknown as RawHit[]).map((c) => c.content_id)
      ),
    ];
    if (contentIds.length === 0) return { assets: [] };

    // Only matched content ids' LIVE assets — a trashed asset stays out
    // (re-upload is the restore path).
    const liveAssets = await ctx.vault.read({
      entity: "media.asset",
      where: [
        { column: "content_id", op: "in", value: contentIds },
        { column: "deleted_at", op: "is-null" },
      ],
      limit: 300,
      purpose,
    });
    const assetsRaw = (liveAssets.rows ?? []) as unknown as RawAsset[];
    if (assetsRaw.length === 0) return { assets: [] };

    const assetIds = assetsRaw.map((a) => a.asset_id);
    const [contents, entries, albums, places, joins] = await Promise.all([
      ctx.vault.read({
        entity: "core.content_item",
        where: [{ column: "content_id", op: "in", value: contentIds }],
        purpose,
      }),
      ctx.vault.read({
        entity: "core.collection_entry",
        where: [
          { column: "target_type", op: "eq", value: "media.asset" },
          { column: "target_id", op: "in", value: assetIds },
        ],
        purpose,
      }),
      ctx.vault.read({ entity: "core.collection", purpose }),
      readPlaces({ ctx, purpose }),
      readAssetJoins({ ctx, purpose, assetIds, contentIds }),
    ]);
    const contentById = new Map(
      ((contents.rows ?? []) as unknown as RawContent[]).map(
        (c) => [c.content_id, c] as const
      )
    );
    const { tagsByAsset, custodyByContent } = joins;

    const albumRows = ((albums.rows ?? []) as unknown as RawCollection[]).map(
      (c) => ({
        album_id: c.collection_id,
        title: c.name,
        cover_content_id: c.cover_content_id ?? null,
      })
    );
    const albumIdsByAsset = new Map<string, string[]>();
    for (const entry of (entries.rows ?? []) as unknown as RawEntry[]) {
      if (!albumIdsByAsset.has(entry.target_id))
        albumIdsByAsset.set(entry.target_id, []);
      albumIdsByAsset.get(entry.target_id)!.push(entry.collection_id);
    }
    const albumsById = new Map(albumRows.map((a) => [a.album_id, a] as const));

    const placeOf = (asset: RawAsset) => {
      const place = asset.place_id
        ? places.byId.get(asset.place_id)
        : undefined;
      return place
        ? {
            place_id: place.place_id,
            name: place.name,
            lat: place.lat,
            lng: place.lng,
            // Library projection shape: identical phrasing as the grid.
            kind: place.kind,
            gazetteer: place.gazetteer,
          }
        : null;
    };

    const assets = assetsRaw
      .filter((a) => contentById.get(a.content_id)?.deleted_at == null)
      .map((asset) => {
        const content = contentById.get(asset.content_id);
        const albumIds = albumIdsByAsset.get(asset.asset_id) ?? [];
        const { src, thumb, preview, poster } = srcOf(content);
        return {
          ...asset,
          favorite: asset.favorite ? 1 : 0,
          content_uri: src,
          thumb_uri: thumb,
          preview_uri: preview,
          poster_uri: poster,
          byte_size: content?.byte_size ?? null,
          media_type: content?.media_type ?? null,
          title: content?.title ?? null,
          taken_at: asset.captured_at ?? content?.created_at ?? null,
          album_ids: albumIds,
          album_titles: albumIds
            .map((id) => albumsById.get(id)?.title)
            .filter((t) => t != null),
          place: placeOf(asset),
          tags: tagsByAsset.get(asset.asset_id) ?? [],
          custody_state: custodyByContent.get(asset.content_id) ?? null,
        };
      });
    // Vault rank order (best match first).
    assets.sort(
      (a, b) =>
        contentIds.indexOf(a.content_id) - contentIds.indexOf(b.content_id)
    );
    return { assets };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    if (e.code === "VAULT_CONSENT") {
      return { assets: [], vaultDenied: { code: e.code, message: e.message } };
    }
    return { assets: [], error: String(e.message ?? error) };
  }
}
