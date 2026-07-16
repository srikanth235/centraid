/**
 * The library projection as bounded recent windows: the newest live assets
 * by captured_at (caller-sized, default 500 — a photo grid wants a deep
 * first page) and the newest 200 trashed ones — never the whole
 * media.media_asset table, and crucially never the whole core.content_item
 * table, because every photo's bytes ride inline as a data: URI and a full
 * content read ships the entire library on every refresh (issue #264).
 * Content items and album entries are joined only for the windowed rows;
 * albums stay a full read (a collection list is small). Media has no text
 * index, so anything older is reachable only by growing the window
 * (`truncated` tells the UI to offer that).
 *
 * Trash is a first-class shelf, not a filter the UI must remember: the
 * `assets` array is live rows only, and trashed assets ride separately in
 * `trash` with days-until-purge from the asset's own purge_at (issue #274:
 * the standard soft-delete pair — the shelf empties even when the bytes
 * stay rented elsewhere).
 *
 * Issue #352 phase 3/4 additions, each a bounded join over the SAME
 * windowed rows (see queries/_shared.js): every asset row now also carries
 * `place` (the linked core.place, or null), `tags` (free-form labels, an
 * array of strings) and `custody_state` (the blob custody projection).
 * `places` rides as a top-level array too (like `albums`) — the full known
 * place list, which the lightbox's place picker offers (there is no
 * app-plane command to mint a brand-new place, only to point an asset at
 * an existing one or clear it).
 *
 * A consent denial is a first-class outcome, not an error: the UI renders
 * it as the "ask the owner for access" state, receipt id included.
 *
 * @type {import('@centraid/app-engine').QueryHandler}
 */
import { readAssetJoins, readPlaces, srcOf } from './_shared.js';

export default async ({ input, ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  const window = Math.min(Math.max(Number(input?.limit) || 500, 20), 2000);
  try {
    const [liveAssets, trashedAssets, albums, places] = await Promise.all([
      // The live window, newest capture first. SQLite ORDER BY … DESC puts
      // NULLs last, so camera-dated photos lead and undated imports trail
      // the window — acceptable semantics for a recency slice.
      ctx.vault.read({
        entity: 'media.media_asset',
        where: [{ column: 'deleted_at', op: 'is-null' }],
        orderBy: { column: 'captured_at', dir: 'desc' },
        limit: window,
        purpose,
      }),
      // The trash window, newest-trashed first. Trash is a ~30-day shelf
      // the lifecycle sweep keeps short, so a fixed cap of 200 covers any
      // plausible shelf without a knob.
      ctx.vault.read({
        entity: 'media.media_asset',
        where: [{ column: 'deleted_at', op: 'not-null' }],
        orderBy: { column: 'deleted_at', dir: 'desc' },
        limit: 200,
        purpose,
      }),
      // Albums are collections (issue #274) — the one curation mechanism.
      ctx.vault.read({ entity: 'core.collection', purpose }),
      readPlaces({ ctx, purpose }),
    ]);

    // Joins are `in`-bounded by the windows — THIS is the point of the
    // exercise: only the windowed photos' bytes travel, and album entries
    // are pulled for windowed assets only.
    const windowed = [...(liveAssets.rows ?? []), ...(trashedAssets.rows ?? [])];
    const assetIds = windowed.map((a) => a.asset_id);
    const contentIds = [...new Set(windowed.map((a) => a.content_id))].filter(Boolean);
    const [entries, contents, joins] = await Promise.all([
      assetIds.length > 0
        ? ctx.vault.read({
            entity: 'core.collection_entry',
            where: [
              { column: 'target_type', op: 'eq', value: 'media.media_asset' },
              { column: 'target_id', op: 'in', value: assetIds },
            ],
            purpose,
          })
        : { rows: [] },
      contentIds.length > 0
        ? ctx.vault.read({
            entity: 'core.content_item',
            where: [{ column: 'content_id', op: 'in', value: contentIds }],
            purpose,
          })
        : { rows: [] },
      readAssetJoins({ ctx, purpose, assetIds, contentIds }),
    ]);

    const contentById = new Map((contents.rows ?? []).map((c) => [c.content_id, c]));
    const { starredIds, tagsByAsset, custodyByContent } = joins;

    // Keep the app's album row shape over collection rows: a collection may
    // also hold notes and documents; this surface renders its photo side.
    const albumRows = (albums.rows ?? []).map((c) => ({
      album_id: c.collection_id,
      title: c.name,
      cover_content_id: c.cover_content_id ?? null,
    }));
    const albumsById = new Map(albumRows.map((a) => [a.album_id, a]));
    const albumIdsByAsset = new Map();
    for (const entry of entries.rows ?? []) {
      if (!albumIdsByAsset.has(entry.target_id)) albumIdsByAsset.set(entry.target_id, []);
      albumIdsByAsset.get(entry.target_id).push(entry.collection_id);
    }

    const placeOf = (asset) => {
      const place = asset.place_id ? places.byId.get(asset.place_id) : undefined;
      return place ? { place_id: place.place_id, name: place.name } : null;
    };

    const join = (asset) => {
      const content = contentById.get(asset.content_id);
      const albumIds = albumIdsByAsset.get(asset.asset_id) ?? [];
      const { src, thumb, preview, poster } = srcOf(content);
      return {
        ...asset,
        favorite: starredIds.has(asset.content_id) ? 1 : 0,
        content_uri: src,
        thumb_uri: thumb,
        preview_uri: preview,
        poster_uri: poster,
        byte_size: content?.byte_size ?? null,
        media_type: content?.media_type ?? null,
        title: content?.title ?? null,
        // The real timestamp: capture time when the camera recorded one,
        // otherwise the content item's creation time in the vault.
        taken_at: asset.captured_at ?? content?.created_at ?? null,
        album_ids: albumIds,
        album_titles: albumIds.map((id) => albumsById.get(id)?.title).filter((t) => t != null),
        place: placeOf(asset),
        tags: tagsByAsset.get(asset.asset_id) ?? [],
        custody_state: custodyByContent.get(asset.content_id) ?? null,
      };
    };

    const live = (liveAssets.rows ?? [])
      // Live means the asset row is live AND its bytes are: a content item
      // carrying deleted_at is released bytes, never rendered as library.
      // A windowed asset whose content turns out deleted is filtered here
      // in memory — rare, and it costs a slot in the window, not correctness.
      .filter((asset) => contentById.get(asset.content_id)?.deleted_at == null)
      .map(join);
    live.sort((a, b) => String(b.taken_at ?? '').localeCompare(String(a.taken_at ?? '')));

    const trash = (trashedAssets.rows ?? []).map((asset) => {
      // The asset carries its own grace window (issue #274); the content
      // fallback covers vaults trashed before the pair landed.
      const purgeAt = asset.purge_at ?? contentById.get(asset.content_id)?.purge_at ?? null;
      const ms = purgeAt == null ? NaN : Date.parse(purgeAt) - Date.now();
      return {
        ...join(asset),
        purge_at: purgeAt,
        // Days until the lifecycle sweep purges — null when the bytes are
        // still rented elsewhere (no purge date) or the date is unreadable.
        purge_in_days: Number.isNaN(ms) ? null : Math.max(0, Math.ceil(ms / 86400000)),
      };
    });
    trash.sort((a, b) => String(b.deleted_at ?? '').localeCompare(String(a.deleted_at ?? '')));

    // A full live window means there may be older photos beyond it — the
    // UI offers "Show more" (a re-read with a larger window).
    const truncated = (liveAssets.rows ?? []).length >= window;
    return {
      assets: live,
      albums: albumRows,
      places: places.rows,
      trash,
      truncated,
      window,
    };
  } catch (err) {
    return {
      assets: [],
      albums: [],
      places: [],
      trash: [],
      vaultDenied: { code: err.code, message: err.message },
    };
  }
};
