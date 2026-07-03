/**
 * The library projection: every media asset joined to its content item
 * (content_uri + media_type — the bytes are rented, the meaning is here)
 * and to the albums it belongs to. Everything comes from the vault —
 * this app holds no rows of its own; every write goes back through the
 * media domain's typed commands.
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

    const joined = (assets.rows ?? [])
      // Soft-deleted content is released bytes: an asset whose content
      // item carries deleted_at has left the library and never renders.
      .filter((asset) => contentById.get(asset.content_id)?.deleted_at == null)
      .map((asset) => {
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
      });
    joined.sort((a, b) => String(b.taken_at ?? '').localeCompare(String(a.taken_at ?? '')));

    return {
      assets: joined,
      albums: albums.rows ?? [],
    };
  } catch (err) {
    return { assets: [], albums: [], vaultDenied: { code: err.code, message: err.message } };
  }
};
