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
 * `trash` with days-until-purge derived from the content item's purge_at
 * (absent when the bytes are still rented elsewhere and never soft-deleted).
 *
 * A consent denial is a first-class outcome, not an error: the UI renders
 * it as the "ask the owner for access" state, receipt id included.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */
export default async ({ input, ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  const window = Math.min(Math.max(Number(input?.limit) || 500, 20), 2000);
  try {
    const [liveAssets, trashedAssets, albums] = await Promise.all([
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
    ]);

    // Joins are `in`-bounded by the windows — THIS is the point of the
    // exercise: only the windowed photos' bytes travel, and album entries
    // are pulled for windowed assets only.
    const windowed = [...(liveAssets.rows ?? []), ...(trashedAssets.rows ?? [])];
    const assetIds = windowed.map((a) => a.asset_id);
    const contentIds = [...new Set(windowed.map((a) => a.content_id))].filter(Boolean);
    const [entries, contents] = await Promise.all([
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
    ]);

    const contentById = new Map((contents.rows ?? []).map((c) => [c.content_id, c]));

    // Favorite is a flags-scheme starred tag on the canonical content item
    // (issue #274) — one bounded read over the windowed content ids, the
    // same star the drive's Starred section reads.
    const [flagSchemes, flagConcepts] = await Promise.all([
      ctx.vault.read({ entity: 'core.concept_scheme', purpose }),
      ctx.vault.read({ entity: 'core.concept', purpose }),
    ]);
    const flagsScheme = (flagSchemes.rows ?? []).find(
      (sch) => sch.uri === 'https://centraid.dev/schemes/flags',
    );
    const starredConcept = flagsScheme
      ? (flagConcepts.rows ?? []).find(
          (c) => c.scheme_id === flagsScheme.scheme_id && c.notation === 'starred',
        )
      : undefined;
    const starredIds = new Set();
    if (starredConcept && contentIds.length > 0) {
      const starTags = await ctx.vault.read({
        entity: 'core.tag',
        where: [
          { column: 'concept_id', op: 'eq', value: starredConcept.concept_id },
          { column: 'target_type', op: 'eq', value: 'core.content_item' },
          { column: 'target_id', op: 'in', value: contentIds },
        ],
        purpose,
      });
      for (const t of starTags.rows ?? []) starredIds.add(t.target_id);
    }
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

    const join = (asset) => {
      const content = contentById.get(asset.content_id);
      const albumIds = albumIdsByAsset.get(asset.asset_id) ?? [];
      return {
        ...asset,
        favorite: starredIds.has(asset.content_id) ? 1 : 0,
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

    const live = (liveAssets.rows ?? [])
      // Live means the asset row is live AND its bytes are: a content item
      // carrying deleted_at is released bytes, never rendered as library.
      // A windowed asset whose content turns out deleted is filtered here
      // in memory — rare, and it costs a slot in the window, not correctness.
      .filter((asset) => contentById.get(asset.content_id)?.deleted_at == null)
      .map(join);
    live.sort((a, b) => String(b.taken_at ?? '').localeCompare(String(a.taken_at ?? '')));

    const trash = (trashedAssets.rows ?? []).map((asset) => {
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

    // A full live window means there may be older photos beyond it — the
    // UI offers "Show more" (a re-read with a larger window).
    const truncated = (liveAssets.rows ?? []).length >= window;
    return {
      assets: live,
      albums: albumRows,
      trash,
      truncated,
      window,
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
