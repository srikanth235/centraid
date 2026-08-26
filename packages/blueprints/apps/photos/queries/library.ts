/**
 * The library projection as bounded windows: newest live assets by captured_at
 * plus the newest 200 trashed. Never read core.content_item whole — bytes ride
 * inline as data: URIs (#264). Keyset cursor (#599): `input.before` admits only
 * strictly older captured_at, `tail` is the next `before`, and NULL
 * captured_at fails that comparison, so undated assets ride the first window
 * only. A consent denial is an outcome, not an error.
 *
 * @type {import('@centraid/server/engine').QueryHandler}
 */
import { readAssetJoins, readPlaces, srcOf } from "./_shared.ts";

interface RawAsset {
  asset_id: string;
  content_id: string;
  favorite?: unknown;
  captured_at?: string | null;
  place_id?: string | null;
  purge_at?: string | null;
  deleted_at?: string | null;
}

interface RawContent {
  content_id: string;
  content_uri?: unknown;
  byte_size?: number | null;
  media_type?: string | null;
  title?: string | null;
  created_at?: string | null;
  deleted_at?: string | null;
  purge_at?: string | null;
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

interface RawMemory {
  memory_id: string;
}

export default async function libraryHandler({ input, ctx }: HandlerArgs) {
  const purpose = "dpv:ServiceProvision";
  const window = Math.min(Math.max(Number(input?.limit) || 500, 20), 2000);
  const before =
    typeof input?.before === "string" && input.before !== ""
      ? input.before
      : null;
  const liveWhere = [
    { column: "deleted_at", op: "is-null" },
    { column: "archived_at", op: "is-null" },
    ...(before ? [{ column: "captured_at", op: "lt", value: before }] : []),
  ];
  try {
    const [liveAssets, trashedAssets, albums, places, memories] =
      await Promise.all([
        ctx.vault.read({
          entity: "media.asset",
          // Archived assets are in neither shelf (#419).
          where: liveWhere,
          orderBy: { column: "captured_at", dir: "desc" },
          limit: window,
          purpose,
        }),
        // A ~30-day shelf the sweep keeps short: 200 needs no knob.
        ctx.vault.read({
          entity: "media.asset",
          where: [{ column: "deleted_at", op: "not-null" }],
          orderBy: { column: "deleted_at", dir: "desc" },
          limit: 200,
          purpose,
        }),
        ctx.vault.read({ entity: "core.collection", purpose }),
        readPlaces({ ctx, purpose }),
        before
          ? { rows: [] }
          : ctx.vault.read({ entity: "media.memory", limit: 200, purpose }),
      ]);

    // Joins stay `in`-bounded: only the windowed photos' bytes travel.
    const liveRows = (liveAssets.rows ?? []) as unknown as RawAsset[];
    const trashRows = (trashedAssets.rows ?? []) as unknown as RawAsset[];
    const windowed = [...liveRows, ...trashRows];
    const assetIds = windowed.map((a) => a.asset_id);
    const contentIds = [...new Set(windowed.map((a) => a.content_id))].filter(
      Boolean
    );
    const memoryRows = (memories.rows ?? []) as unknown as RawMemory[];
    const memoryIds = memoryRows.map((memory) => memory.memory_id);
    const [entries, contents, joins, memoryMembers] = await Promise.all([
      assetIds.length > 0
        ? ctx.vault.read({
            entity: "core.collection_entry",
            where: [
              { column: "target_type", op: "eq", value: "media.asset" },
              { column: "target_id", op: "in", value: assetIds },
            ],
            purpose,
          })
        : { rows: [] },
      contentIds.length > 0
        ? ctx.vault.read({
            entity: "core.content_item",
            where: [{ column: "content_id", op: "in", value: contentIds }],
            purpose,
          })
        : { rows: [] },
      readAssetJoins({ ctx, purpose, assetIds, contentIds }),
      memoryIds.length > 0
        ? ctx.vault.read({
            entity: "media.memory_member",
            where: [{ column: "memory_id", op: "in", value: memoryIds }],
            orderBy: { column: "ordinal", dir: "asc" },
            limit: 4000,
            purpose,
          })
        : { rows: [] },
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
    const albumsById = new Map(albumRows.map((a) => [a.album_id, a] as const));
    const albumIdsByAsset = new Map<string, string[]>();
    for (const entry of (entries.rows ?? []) as unknown as RawEntry[]) {
      if (!albumIdsByAsset.has(entry.target_id))
        albumIdsByAsset.set(entry.target_id, []);
      albumIdsByAsset.get(entry.target_id)!.push(entry.collection_id);
    }

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
            kind: place.kind,
            gazetteer: place.gazetteer,
          }
        : null;
    };

    const join = (asset: RawAsset) => {
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
    };

    const live = liveRows
      // Live means the bytes are live too: released content is never library.
      .filter((asset) => contentById.get(asset.content_id)?.deleted_at == null)
      .map(join);
    live.sort((a, b) =>
      String(b.taken_at ?? "").localeCompare(String(a.taken_at ?? ""))
    );

    const trash = trashRows.map((asset) => {
      // The asset owns the grace window (#274); content is the fallback.
      const purgeAt =
        asset.purge_at ?? contentById.get(asset.content_id)?.purge_at ?? null;
      const ms = purgeAt == null ? NaN : Date.parse(purgeAt) - Date.now();
      return {
        ...join(asset),
        purge_at: purgeAt,
        purge_in_days: Number.isNaN(ms)
          ? null
          : Math.max(0, Math.ceil(ms / 86400000)),
      };
    });
    trash.sort((a, b) =>
      String(b.deleted_at ?? "").localeCompare(String(a.deleted_at ?? ""))
    );

    const truncated = liveRows.length >= window;
    const tail =
      live.length > 0 ? (live[live.length - 1]!.taken_at ?? null) : null;
    return {
      assets: live,
      albums: albumRows,
      places: places.rows,
      trash,
      memories: memoryRows,
      memoryMembers: memoryMembers.rows ?? [],
      truncated,
      window,
      tail,
    };
  } catch (error) {
    const empty = {
      assets: [],
      albums: [],
      places: [],
      trash: [],
      memories: [],
      memoryMembers: [],
      tail: null,
    };
    // Only a consent deny is "ask the owner"; every other failure is ours.
    const e = error as { code?: string; message?: string };
    if (e.code === "VAULT_CONSENT") {
      return { ...empty, vaultDenied: { code: e.code, message: e.message } };
    }
    return { ...empty, error: String(e.message ?? error) };
  }
}
