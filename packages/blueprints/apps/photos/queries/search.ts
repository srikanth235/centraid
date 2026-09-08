import { inList, readPages } from "../../_shared/paged-reads.ts";
/**
 * Photo search as a vault projection (#352): the in-vault FTS5 index matches
 * titles/captions on core.content_item. Only matched content ids' live assets
 * are read, never a table scan; trashed items fall out of the index.
 *
 * Row shape mirrors queries/library.js's `join()` output row-for-row so hits
 * render straight into the existing grid; album-name matching stays
 * client-side. Consent denial is a first-class outcome.
 */
import {
  ownerKey,
  readRepresentations,
} from "../../_shared/representation-reads.ts";
import { readAssetJoins, readPlaces, srcOf } from "./_shared.ts";

/** The search shelf shows this many matches. */
const MATCH_ROWS = 300;

interface RawHit {
  content_id: string;
}

interface RawAsset {
  asset_id: string;
  content_id: string;
  captured_at?: string | null;
  place_id?: string | null;
}

interface RawContent {
  content_id: string;
  content_uri?: unknown;
  byte_size?: number | null;
  created_at?: string | null;
  deleted_at?: string | null;
}

interface RawEntry {
  entry_id: string;
  target_id: string;
  collection_id: string;
}

interface RawCollection {
  collection_id: string;
  name?: string | null;
  cover_content_id?: string | null;
}

export default async function searchHandler({ input, ctx }: HandlerArgs) {
  const term = String(input?.term ?? "").trim();
  if (!term) return { assets: [] };
  try {
    const hits = await ctx.vault.search({
      entity: "core.content_item",
      query: term,
      limit: 300,
    });
    const contentIds = [
      ...new Set(
        ((hits.rows ?? []) as unknown as RawHit[]).map((c) => c.content_id)
      ),
    ];
    if (contentIds.length === 0) return { assets: [] };

    // Only matched content ids' LIVE assets — a trashed asset stays out
    // (re-upload is the restore path).
    const matchedIn = inList("content_id", contentIds);
    const liveAssets = await ctx.vault.page<RawAsset>({
      query: {
        name: "photos.search.assets",
        select:
          "asset_id, content_id, kind, title, captured_at, place_id, width, height, duration_s, deleted_at",
        from: "media_asset",
        where: `${matchedIn.sql} AND deleted_at IS NULL`,
        bind: matchedIn.bind,
        order: {
          sortColumn: "captured_at",
          pkColumn: "asset_id",
          descending: true,
        },
      },
      limit: MATCH_ROWS,
    });
    const assetsRaw = liveAssets.rows;
    if (assetsRaw.length === 0) return { assets: [] };

    const assetIds = assetsRaw.map((a) => a.asset_id);
    const [contents, entries, albums, places, joins, representations] =
      await Promise.all([
        readPages<RawContent>(ctx, {
          name: "photos.search.contents",
          select: "content_id, content_uri, byte_size",
          from: "core_content_item",
          where: matchedIn.sql,
          bind: matchedIn.bind,
          order: {
            sortColumn: "content_id",
            pkColumn: "content_id",
            descending: false,
          },
        }),
        readPages<RawEntry>(ctx, {
          name: "photos.search.albumEntries",
          select: "entry_id, target_type, target_id, collection_id",
          from: "core_collection_entry",
          where: `target_type = ? AND ${inList("target_id", assetIds).sql}`,
          bind: ["media.asset", ...inList("target_id", assetIds).bind],
          order: {
            sortColumn: "entry_id",
            pkColumn: "entry_id",
            descending: false,
          },
        }),
        readPages<RawCollection>(ctx, {
          name: "photos.search.albums",
          select: "collection_id, name, cover_content_id",
          from: "core_collection",
          order: {
            sortColumn: "collection_id",
            pkColumn: "collection_id",
            descending: false,
          },
        }),
        readPlaces({ ctx }),
        readAssetJoins({ ctx, assetIds, contentIds }),
        // Bytes carry no media type since #996 (R20(b)).
        readRepresentations({ ctx, contentIds }),
      ]);
    const contentById = new Map(
      contents.map((c) => [c.content_id, c] as const)
    );
    const { tagsByAsset, favoriteAssets, custodyByContent } = joins;

    const albumRows = albums.map((c) => ({
      album_id: c.collection_id,
      title: c.name,
      cover_content_id: c.cover_content_id ?? null,
    }));
    const albumIdsByAsset = new Map<string, string[]>();
    for (const entry of entries) {
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
          favorite: favoriteAssets.has(asset.asset_id) ? 1 : 0,
          content_uri: src,
          thumb_uri: thumb,
          preview_uri: preview,
          poster_uri: poster,
          byte_size: content?.byte_size ?? null,
          media_type:
            representations.byOwner.get(
              ownerKey("media.asset", asset.asset_id)
            ) ?? null,
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
    if (e.code === "VAULT_ACCESS") {
      return { assets: [], vaultDenied: { code: e.code, message: e.message } };
    }
    return { assets: [], error: String(e.message ?? error) };
  }
}
