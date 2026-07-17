/**
 * Photo search as a vault projection (issue #352 phase 3): the FTS5 index
 * inside the vault matches titles/captions on core.content_item — the same
 * field media.update_asset writes a caption to (Lightbox.jsx's caption
 * field) — so the app never pulls the whole library to grep it in memory.
 * Unlike the library query's windowed recency slice, a search reaches the
 * WHOLE live library: only the matched content ids' assets get read, never
 * a table scan. Trashed photos can't match at all — a soft-deleted content
 * item falls out of the index, mirroring the library query's live-only
 * asset shelf.
 *
 * The row shape mirrors queries/library.js's `join()` output row-for-row
 * (place/tags/custody_state included, via the same queries/_shared.js
 * helpers — phase 3/4) so a hit can render straight into the existing grid
 * components without a second mapping layer. Album-NAME matching (typing
 * "vacation" to surface everything in the Vacation album) deliberately
 * stays a client-side concern in app.jsx — the album list is already fully
 * loaded, so there is no vault round trip worth adding for it.
 *
 * A consent denial is a first-class outcome, not an error: the UI renders
 * it as the "ask the owner for access" state.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */
import { readAssetJoins, readPlaces, srcOf } from './_shared.js';

export default async ({ input, ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  const term = String(input?.term ?? '').trim();
  if (!term) return { assets: [] };
  try {
    const hits = await ctx.vault.search({
      entity: 'core.content_item',
      query: term,
      limit: 300,
      purpose,
    });
    const contentIds = [...new Set((hits.rows ?? []).map((c) => c.content_id))];
    if (contentIds.length === 0) return { assets: [] };

    // Only the matched content ids' LIVE assets — the search never widens
    // into a table scan, and a trashed asset over matched bytes stays out
    // (re-uploading it is the restore path, same as the library query).
    const liveAssets = await ctx.vault.read({
      entity: 'media.media_asset',
      where: [
        { column: 'content_id', op: 'in', value: contentIds },
        { column: 'deleted_at', op: 'is-null' },
      ],
      limit: 300,
      purpose,
    });
    const assetsRaw = liveAssets.rows ?? [];
    if (assetsRaw.length === 0) return { assets: [] };

    const assetIds = assetsRaw.map((a) => a.asset_id);
    const [contents, entries, albums, places, joins] = await Promise.all([
      ctx.vault.read({
        entity: 'core.content_item',
        where: [{ column: 'content_id', op: 'in', value: contentIds }],
        purpose,
      }),
      ctx.vault.read({
        entity: 'core.collection_entry',
        where: [
          { column: 'target_type', op: 'eq', value: 'media.media_asset' },
          { column: 'target_id', op: 'in', value: assetIds },
        ],
        purpose,
      }),
      ctx.vault.read({ entity: 'core.collection', purpose }),
      readPlaces({ ctx, purpose }),
      readAssetJoins({ ctx, purpose, assetIds, contentIds }),
    ]);
    const contentById = new Map((contents.rows ?? []).map((c) => [c.content_id, c]));
    const { tagsByAsset, custodyByContent } = joins;

    const albumRows = (albums.rows ?? []).map((c) => ({
      album_id: c.collection_id,
      title: c.name,
      cover_content_id: c.cover_content_id ?? null,
    }));
    const albumIdsByAsset = new Map();
    for (const entry of entries.rows ?? []) {
      if (!albumIdsByAsset.has(entry.target_id)) albumIdsByAsset.set(entry.target_id, []);
      albumIdsByAsset.get(entry.target_id).push(entry.collection_id);
    }
    const albumsById = new Map(albumRows.map((a) => [a.album_id, a]));

    const placeOf = (asset) => {
      const place = asset.place_id ? places.byId.get(asset.place_id) : undefined;
      return place ? { place_id: place.place_id, name: place.name } : null;
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
          album_titles: albumIds.map((id) => albumsById.get(id)?.title).filter((t) => t != null),
          place: placeOf(asset),
          tags: tagsByAsset.get(asset.asset_id) ?? [],
          custody_state: custodyByContent.get(asset.content_id) ?? null,
        };
      });
    // Vault rank order (best match first).
    assets.sort((a, b) => contentIds.indexOf(a.content_id) - contentIds.indexOf(b.content_id));
    return { assets };
  } catch (err) {
    if (err.code === 'VAULT_CONSENT') {
      return { assets: [], vaultDenied: { code: err.code, message: err.message } };
    }
    return { assets: [], error: String(err.message ?? err) };
  }
};
