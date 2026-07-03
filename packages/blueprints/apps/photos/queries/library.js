/**
 * The library projection: every media asset joined to its content item
 * (content_uri + media_type — the bytes are rented, the meaning is here)
 * and to the albums it belongs to. Everything comes from the vault —
 * this app holds no rows of its own; every write goes back through the
 * media domain's typed commands.
 *
 * Trash is a first-class shelf, not a filter the UI must remember: the
 * `assets` array is live rows only, and trashed assets ride separately in
 * `trash` with days-until-purge derived from the content item's purge_at
 * (absent when the bytes are still rented elsewhere and never soft-deleted).
 *
 * A consent denial is a first-class outcome, not an error: the UI renders
 * it as the "ask the owner for access" state, receipt id included.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */
export default async ({ ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  try {
    const [assets, albums, entries, contents] = await Promise.all([
      ctx.vault.read({ entity: 'media.media_asset', purpose }),
      ctx.vault.read({ entity: 'media.album', purpose }),
      ctx.vault.read({ entity: 'media.album_entry', purpose }),
      ctx.vault.read({ entity: 'core.content_item', purpose }),
    ]);

    const contentById = new Map((contents.rows ?? []).map((c) => [c.content_id, c]));
    const albumsById = new Map((albums.rows ?? []).map((a) => [a.album_id, a]));
    const albumIdsByAsset = new Map();
    for (const entry of entries.rows ?? []) {
      if (!albumIdsByAsset.has(entry.asset_id)) albumIdsByAsset.set(entry.asset_id, []);
      albumIdsByAsset.get(entry.asset_id).push(entry.album_id);
    }

    const join = (asset) => {
      const content = contentById.get(asset.content_id);
      const albumIds = albumIdsByAsset.get(asset.asset_id) ?? [];
      return {
        ...asset,
        content_uri: content?.content_uri ?? null,
        media_type: content?.media_type ?? null,
        title: content?.title ?? null,
        // The real timestamp: capture time when the camera recorded one,
        // otherwise the content item's creation time in the vault.
        taken_at: asset.captured_at ?? content?.created_at ?? null,
        album_ids: albumIds,
        album_titles: albumIds.map((id) => albumsById.get(id)?.title).filter((t) => t != null),
      };
    };

    const rows = assets.rows ?? [];
    const live = rows
      // Live means the asset row is live AND its bytes are: a content item
      // carrying deleted_at is released bytes, never rendered as library.
      .filter(
        (asset) =>
          asset.deleted_at == null && contentById.get(asset.content_id)?.deleted_at == null,
      )
      .map(join);
    live.sort((a, b) => String(b.taken_at ?? '').localeCompare(String(a.taken_at ?? '')));

    const trash = rows
      .filter((asset) => asset.deleted_at != null)
      .map((asset) => {
        const purgeAt = contentById.get(asset.content_id)?.purge_at ?? null;
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

    return {
      assets: live,
      albums: albums.rows ?? [],
      trash,
    };
  } catch (err) {
    return {
      assets: [],
      albums: [],
      trash: [],
      vaultDenied: { code: err.code, message: err.message },
    };
  }
};
