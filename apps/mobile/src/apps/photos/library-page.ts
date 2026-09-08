// THE PHOTO LIBRARY, JOINED IN SQLITE (#996, R8 and W5-D1).
//
// WHAT THIS REPLACES. The timeline engine read SEVEN WHOLE TABLES through the
// declarative plane — `media.asset`, `core.content_item`,
// `core.content_derivative`, `media.asset_phash`, `core.tag`, `core.concept`
// and `core.concept_scheme`, each at `limit: 100_000` — and then joined them in
// JavaScript with five `Map`s. The join is SQLite's job, and it has the indexes
// for it; the JS held the whole of every table to answer questions about a few
// columns of one.
//
// AND IT IS NOT `timelinePage`. That module walks the TIMELINE — its two
// indexes are PARTIAL, on `archived_at IS NULL AND deleted_at IS NULL AND
// captured_at IS NOT NULL`, because a timeline is what a member has not put
// away. The engine's snapshot is the LIBRARY: `PhotoStateView` draws Archive
// and Trash from it and `photos-library-counts.ts` counts them, so a statement
// that inherited the timeline's predicate would empty two screens. Same file,
// same keyset discipline, different question.
//
// THE WALK IS KEYED ON THE PRIMARY KEY, NOT ON CAPTURE TIME, and that is a
// decision rather than an oversight. A keyset must be TOTAL: `captured_at` is
// nullable — an import with no EXIF date has none — and `(NULL, id) < (?, ?)`
// evaluates to NULL, so a walk keyed on it would STOP at the first dateless
// asset and silently lose every row behind it. The obvious repair, coalescing
// to the bytes' `created_at`, cannot be the key either: `pageStatement` puts
// the keyset in the WHERE clause, and SQL has no way to reference a SELECT
// alias there.
//
// Which costs nothing here, because this walk reads the WHOLE library and the
// snapshot is ordered afterwards by `sectionPhotoAssets`. `asset_id` is unique
// and NOT NULL, so `ORDER BY asset_id` is one index scan with no temp B-tree —
// `pageStatement` collapses the pair when the sort column IS the primary key.
// The coalesced capture time is still PROJECTED, because the snapshot reads it;
// it is simply not what the pages are cut on.

import type { SeatSqliteDriver } from "@centraid/client/replica/native";
import { seatPage } from "@centraid/client/replica/seat/paged-handler";
import type { Page, PageQuery, PageRequest } from "@centraid/core/page";

/** The starred flag's home (`packages/vault/src/commands/flags.ts`). */
export const FLAGS_SCHEME_URI = "https://centraid.dev/schemes/flags";
export const STARRED_NOTATION = "starred";
/** Photos' star anchors on the ASSET, not the shared bytes (#916, rung nine). */
export const ASSET_TARGET_TYPE = "media.asset";

/** One asset, with everything the snapshot reads about it already joined. */
export interface PhotoLibraryRow {
  asset_id: string;
  content_id: string;
  kind: string;
  /** THE AUTHORED TITLE (#996, R20(b)) — on the asset, not on the byte row. */
  title: string | null;
  captured_at: string | null;
  /** `captured_at`, or the bytes' `created_at`; never null. The keyset's key. */
  captured_key: string;
  tz_offset_min: number | null;
  capture_group_id: string | null;
  place_id: string | null;
  width: number | null;
  height: number | null;
  duration_s: number | null;
  exif_json: string | null;
  archived_at: string | null;
  deleted_at: string | null;
  purge_at: string | null;
  sha256: string;
  byte_size: number;
  thumbhash: string | null;
  phash: string | null;
  /** 1 when a `starred` flag tag points at this asset. */
  starred: number;
}

/**
 * The concept id the star is, or `undefined` when nothing has ever been
 * starred in this vault.
 *
 * Resolved ONCE per pass and bound into the library statement, rather than
 * joined through `core_concept`/`core_concept_scheme` on every row: it is one
 * value, and two extra joins per asset to re-derive a constant is what the JS
 * version was doing with two whole tables.
 *
 * Absent is an honest empty set, not a missing join.
 */
export function starredConceptQuery(): PageQuery<{ concept_id: string }> {
  return {
    name: "photos.library.starred-concept",
    select: "c.concept_id",
    from: `core_concept c JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id`,
    where: "s.uri = ? AND c.notation = ?",
    bind: [FLAGS_SCHEME_URI, STARRED_NOTATION],
    order: {
      sortColumn: "concept_id",
      pkColumn: "concept_id",
      descending: false,
    },
  };
}

/** The same lookup, in process — the shape the suites and the walk both use. */
export function starredConceptId(driver: SeatSqliteDriver): string | undefined {
  return seatPage<{ concept_id: string }>(driver, starredConceptQuery(), {
    limit: 1,
  }).rows[0]?.concept_id;
}

const CAPTURED_KEY = "coalesce(a.captured_at, c.created_at, '')";

/**
 * The library's statement, minus the parts the handler host owns.
 *
 * `starred` is a correlated EXISTS rather than a LEFT JOIN on `core_tag`: an
 * asset can carry many tags, and a join would multiply the row and then need a
 * DISTINCT — which is a sort, over the whole library, to answer a boolean.
 */
export function photoLibraryQuery(
  starredConcept: string | undefined
): PageQuery<PhotoLibraryRow> {
  return {
    name: "photos.library",
    select: `a.asset_id, a.content_id, a.kind, a.title, a.captured_at,
             ${CAPTURED_KEY} AS captured_key,
             a.tz_offset_min, a.capture_group_id, a.place_id, a.width,
             a.height, a.duration_s, a.exif_json, a.archived_at, a.deleted_at,
             coalesce(a.purge_at, c.purge_at) AS purge_at,
             c.sha256, c.byte_size,
             (SELECT d.text_content FROM core_content_derivative d
               WHERE d.content_id = a.content_id AND d.variant = 'thumbhash')
               AS thumbhash,
             (SELECT p.phash FROM media_asset_phash p
               WHERE p.asset_id = a.asset_id) AS phash,
             (SELECT EXISTS (SELECT 1 FROM core_tag t
                WHERE t.target_type = ? AND t.target_id = a.asset_id
                  AND t.concept_id = ?)) AS starred`,
    // INNER join: the engine already dropped an asset whose bytes it could not
    // find (`if (!contentId || !assetId || !sha) return []`), because there is
    // nothing to draw for one.
    from: `media_asset a JOIN core_content_item c ON c.content_id = a.content_id`,
    bind: [ASSET_TARGET_TYPE, starredConcept ?? ""],
    order: {
      // BARE, not `a.asset_id`: `pageCursorOf` reads the cursor off the ROW,
      // and SQLite names that column `asset_id`. It is unambiguous here —
      // `core_content_item` has no such column — so the WHERE and ORDER BY the
      // host splices in resolve to the asset's.
      sortColumn: "asset_id",
      pkColumn: "asset_id",
      descending: false,
    },
  };
}

/** One page of the library. */
export function photoLibraryPage(
  driver: SeatSqliteDriver,
  starredConcept: string | undefined,
  request: PageRequest
): Page<PhotoLibraryRow> {
  return seatPage<PhotoLibraryRow>(
    driver,
    photoLibraryQuery(starredConcept),
    request
  );
}
