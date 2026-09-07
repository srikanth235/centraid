import { DAY_MS } from "../../_shared/format-kit.ts";
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
import { inList, readPages } from "../../_shared/paged-reads.ts";
import {
  ownerKey,
  readRepresentations,
} from "../../_shared/representation-reads.ts";
import { readAssetJoins, readPlaces, srcOf } from "./_shared.ts";

/** One `media.asset` row, as both shelves project it. */
const ASSET_COLUMNS =
  "asset_id, content_id, kind, title, captured_at, tz_offset_min, " +
  "capture_group_id, place_id, camera_device_id, width, height, duration_s, " +
  "source_asset_id, archived_at, deleted_at, purge_at, created_at, updated_at";

/** The trash and memory shelves are what the screen shows. */
const SHELF_ROWS = 200;

interface RawAsset {
  asset_id: string;
  content_id: string;
  captured_at?: string | null;
  place_id?: string | null;
  purge_at?: string | null;
  deleted_at?: string | null;
}

interface RawContent {
  content_id: string;
  content_uri?: unknown;
  byte_size?: number | null;
  created_at?: string | null;
  deleted_at?: string | null;
  purge_at?: string | null;
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

interface RawMemory {
  memory_id: string;
}

export default async function libraryHandler({ input, ctx }: HandlerArgs) {
  const window = Math.min(Math.max(Number(input?.limit) || 500, 20), 2000);
  const before =
    typeof input?.before === "string" && input.before !== ""
      ? input.before
      : null;
  // Archived assets are in neither shelf (#419).
  const liveWhere = before
    ? "deleted_at IS NULL AND archived_at IS NULL AND captured_at < ?"
    : "deleted_at IS NULL AND archived_at IS NULL";
  try {
    const [liveAssets, trashedAssets, albumRowsRead, places, memories] =
      await Promise.all([
        ctx.vault.page<RawAsset>({
          query: {
            name: "photos.library.live",
            select: ASSET_COLUMNS,
            from: "media_asset",
            where: liveWhere,
            ...(before ? { bind: [before] } : {}),
            order: {
              sortColumn: "captured_at",
              pkColumn: "asset_id",
              descending: true,
            },
          },
          limit: window,
        }),
        // A ~30-day shelf the sweep keeps short: 200 needs no knob.
        ctx.vault.page<RawAsset>({
          query: {
            name: "photos.library.trash",
            select: ASSET_COLUMNS,
            from: "media_asset",
            where: "deleted_at IS NOT NULL",
            order: {
              sortColumn: "deleted_at",
              pkColumn: "asset_id",
              descending: true,
            },
          },
          limit: SHELF_ROWS,
        }),
        // Albums are collections: owner-curated and small.
        readPages<RawCollection>(ctx, {
          name: "photos.library.albums",
          select: "collection_id, name, cover_content_id",
          from: "core_collection",
          order: {
            sortColumn: "collection_id",
            pkColumn: "collection_id",
            descending: false,
          },
        }),
        readPlaces({ ctx }),
        before
          ? Promise.resolve({ rows: [] as RawMemory[] })
          : ctx.vault.page<RawMemory>({
              query: {
                name: "photos.library.memories",
                select:
                  "memory_id, kind, title_hint, day_key, place_id, started_at, ended_at, computed_at",
                from: "media_memory",
                order: {
                  sortColumn: "computed_at",
                  pkColumn: "memory_id",
                  descending: true,
                },
              },
              limit: SHELF_ROWS,
            }),
      ]);

    // Joins stay `in`-bounded: only the windowed photos' bytes travel.
    const liveRows = liveAssets.rows;
    const trashRows = trashedAssets.rows;
    const windowed = [...liveRows, ...trashRows];
    const assetIds = windowed.map((a) => a.asset_id);
    const contentIds = [...new Set(windowed.map((a) => a.content_id))].filter(
      Boolean
    );
    const memoryRows = memories.rows;
    const memoryIds = memoryRows.map((memory) => memory.memory_id);
    const entryIn = assetIds.length > 0 ? inList("target_id", assetIds) : null;
    const contentIn =
      contentIds.length > 0 ? inList("content_id", contentIds) : null;
    const memoryIn =
      memoryIds.length > 0 ? inList("memory_id", memoryIds) : null;
    const [entryRows, contentRows, joins, memoryMemberRows, representations] =
      await Promise.all([
        entryIn
          ? readPages<RawEntry>(ctx, {
              name: "photos.library.albumEntries",
              select: "entry_id, target_type, target_id, collection_id",
              from: "core_collection_entry",
              where: `target_type = ? AND ${entryIn.sql}`,
              bind: ["media.asset", ...entryIn.bind],
              order: {
                sortColumn: "entry_id",
                pkColumn: "entry_id",
                descending: false,
              },
            })
          : Promise.resolve([] as RawEntry[]),
        contentIn
          ? readPages<RawContent>(ctx, {
              name: "photos.library.contents",
              select:
                "content_id, content_uri, byte_size, created_at, deleted_at, purge_at",
              from: "core_content_item",
              where: contentIn.sql,
              bind: contentIn.bind,
              order: {
                sortColumn: "content_id",
                pkColumn: "content_id",
                descending: false,
              },
            })
          : Promise.resolve([] as RawContent[]),
        readAssetJoins({ ctx, assetIds, contentIds }),
        // THE KEYSET IS THE TABLE'S OWN PAIR: `media_memory_member` is keyed on
        // (memory_id, asset_id), and `ordinal` deliberately TIES — two photos
        // taken in the same second share one — so a cursor on it alone would
        // stop at the tie and call the memory finished.
        memoryIn
          ? readPages<Record<string, unknown>>(ctx, {
              name: "photos.library.memoryMembers",
              select: "memory_id, asset_id, ordinal",
              from: "media_memory_member",
              where: memoryIn.sql,
              bind: memoryIn.bind,
              order: {
                sortColumn: "memory_id",
                pkColumn: "asset_id",
                descending: false,
              },
            })
          : Promise.resolve([] as Record<string, unknown>[]),
        // Bytes carry no media type since #996 (R20(b)) — the ASSET's own
        // representation says what they are, and its title is its own.
        readRepresentations({ ctx, contentIds }),
      ]);

    const contentById = new Map(
      contentRows.map((c) => [c.content_id, c] as const)
    );
    const { tagsByAsset, favoriteAssets, custodyByContent } = joins;

    const albumRows = albumRowsRead.map((c) => ({
      album_id: c.collection_id,
      title: c.name,
      cover_content_id: c.cover_content_id ?? null,
    }));
    const albumsById = new Map(albumRows.map((a) => [a.album_id, a] as const));
    const albumIdsByAsset = new Map<string, string[]>();
    for (const entry of entryRows) {
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
          : Math.max(0, Math.ceil(ms / DAY_MS)),
      };
    });
    trash.sort((a, b) =>
      String(b.deleted_at ?? "").localeCompare(String(a.deleted_at ?? ""))
    );

    // The page's own cursor, not a row count that cannot tell a window that
    // filled exactly from one that ran out (#996 wave 4).
    const truncated = liveAssets.next !== undefined;
    const tail =
      live.length > 0 ? (live[live.length - 1]!.taken_at ?? null) : null;
    return {
      assets: live,
      albums: albumRows,
      places: places.rows,
      trash,
      memories: memoryRows,
      memoryMembers: memoryMemberRows,
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
    if (e.code === "VAULT_ACCESS") {
      return { ...empty, vaultDenied: { code: e.code, message: e.message } };
    }
    return { ...empty, error: String(e.message ?? error) };
  }
}
