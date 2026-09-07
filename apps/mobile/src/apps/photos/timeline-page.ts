// THE PHOTO TIMELINE, PAGED IN SQLITE (#996 wave 3).
//
// The old path read `media.asset` whole and folded it into day sections in
// JavaScript (`timeline-model.ts`'s `sectionPhotoAssets`). At the year-3
// volume this wave is cut to — tens of thousands of captures — that is the
// library's cost to draw the first screen, every time, and no amount of
// memoisation above it changes what SQLite was asked for.
//
// KEYSET, NOT OFFSET. `LIMIT n OFFSET k` makes SQLite walk and discard k rows,
// so page 100 costs a hundred pages; a keyset names the last row it saw and
// costs one seek. The key is `(captured_at, asset_id)` compared as a ROW VALUE
// — `(a, b) < (?, ?)` — which SQLite turns into an index seek rather than the
// `a < ? OR (a = ? AND b < ?)` an optimiser has to be talked into. Row values
// are SQLite 3.15, twenty releases under `SEAT_SQLITE_FLOOR`.
//
// THE KEY IS PLAIN COLUMNS, AND THAT WAS MEASURED, NOT ASSUMED. The first
// draft ordered and keyed on the local-day EXPRESSION, so that one index could
// serve both the page and the month aggregate. `EXPLAIN QUERY PLAN` answered
// `SCAN … USING INDEX`, not `SEARCH`: SQLite will not turn a row-value range
// over an expression index into a seek, so every page walked the index from
// the top. On 60,000 rows that is 33 us at the newest page and 4,324 us at the
// oldest — the offset cost this module exists to delete, wearing a
// returned-row count that looked perfectly cheap. On plain columns the same
// query is `SEARCH … (captured_at>? AND (captured_at,asset_id)<(?,?))` and
// flat with depth. So there are TWO indexes: the page seeks one, the scrubber
// aggregates the other, and neither pretends to be the other.
//
// WHICH LEAVES ONE THING FOR THE SECTIONS TO HANDLE. Ordered by `captured_at`,
// two rows of the same local day can be separated by a row from another day
// when their offsets differ — so a day can appear twice in one page, and the
// slicer folds those back together rather than emitting the header twice.
//
// THE BUCKETS ARE A `GROUP BY` OVER AN INDEXED EXPRESSION, NEVER A SECOND
// TABLE. A `timeline_day` table would be a second truth about the same rows,
// kept in step by triggers the seat does not have and would have to invent —
// and the seat's only surviving triggers are FTS sync. What it has instead is
// its own index, which is the thing a seat is allowed to add to its copy: an
// EXPRESSION index on the capture-local day. `GROUP BY` over it returns one
// row per month, so the scrubber costs 36 rows for three years, not 19,710.
//
// THE DAY IS THE CAPTURE-LOCAL ONE. `captured_at` is a UTC instant and
// `tz_offset_min` is the zone the shutter fired in (#419); a photo taken at
// 23:30 in Tokyo and one taken at the same instant in London are different
// days to the people who took them, and a timeline that groups by the UTC date
// tells one of them their evening happened tomorrow.

import type {
  SeatBindValue,
  SeatSqliteDriver,
} from "@centraid/client/replica/native";

/**
 * The capture-local day, as SQL.
 *
 * `||` and not `concat()`: `concat()` is SQLite 3.44 and the phone runs 3.49.1
 * only because SQLCipher pins it there — but the floor is the floor, and this
 * expression is also what the INDEX is built on, so a build that could not
 * parse it could not open the file.
 *
 * A NULL offset is "the camera never recorded a zone", which reads as UTC.
 * That is the same answer `captureLocalDay` gives on the JS side, and the two
 * must agree or a section header and its rows disagree.
 */
const LOCAL_DAY_SQL =
  "substr(datetime(captured_at, (coalesce(tz_offset_min, 0) || ' minutes')), 1, 10)";

/**
 * The seat's two indexes for the timeline. Both PARTIAL, on the timeline's
 * exact predicate: an archived or trashed asset is not in either index at all,
 * so skipping them costs nothing rather than a row read each.
 *
 * A SEAT MAY ADD AN INDEX TO ITS OWN COPY. It may not add a TABLE — a
 * `timeline_day` rollup would be a second truth about the same rows, kept in
 * step by triggers the seat does not have and would have to invent, and the
 * seat's only surviving triggers are FTS sync.
 */
export const SEAT_TIMELINE_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS seat_media_timeline_idx
  ON media_asset(captured_at DESC, asset_id DESC)
  WHERE archived_at IS NULL AND deleted_at IS NULL AND captured_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS seat_media_local_day_idx
  ON media_asset(${LOCAL_DAY_SQL} DESC)
  WHERE archived_at IS NULL AND deleted_at IS NULL AND captured_at IS NOT NULL;
`;

/** Where the last page stopped. Opaque to callers; it is the sort key. */
export interface TimelineCursor {
  capturedAt: string;
  assetId: string;
}

export interface TimelineRow {
  assetId: string;
  contentId: string;
  kind: string;
  capturedAt: string;
  tzOffsetMin: number | null;
  /** The capture-local day SQLite computed, so the header cannot disagree. */
  localDay: string;
}

/** A day boundary the PAGE crosses — derived from the page, never a second read. */
export interface TimelineSectionSlice {
  day: string;
  month: string;
  assetIds: string[];
}

export interface TimelinePageResult {
  assets: TimelineRow[];
  sections: TimelineSectionSlice[];
  /** Absent when the library ended: the walk stops, it does not wrap. */
  nextCursor?: TimelineCursor;
}

export interface TimelinePageRequest {
  limit: number;
  after?: TimelineCursor;
}

interface PageRow {
  asset_id: string;
  content_id: string;
  kind: string;
  captured_at: string;
  tz_offset_min: number | null;
  local_day: string;
}

/**
 * One page of the timeline, newest first.
 *
 * ONE STATEMENT, `limit + 1` ROWS. The extra row is the probe that separates
 * "the window filled" from "the library ends here" (#922 0a) and is dropped
 * before the caller sees it — the same rule the read plan uses, for the same
 * reason.
 */
export function timelinePage(
  driver: SeatSqliteDriver,
  request: TimelinePageRequest
): TimelinePageResult {
  const bind: SeatBindValue[] = [];
  // The keyset, as a row value over the index's own columns: one seek down the
  // index, not a scan with a discarded prefix and a sort on the end.
  const keyset = request.after ? "AND (captured_at, asset_id) < (?, ?)" : "";
  if (request.after) bind.push(request.after.capturedAt, request.after.assetId);
  bind.push(request.limit + 1);
  const rows = driver.all<PageRow>(
    `SELECT asset_id, content_id, kind, captured_at, tz_offset_min,
            ${LOCAL_DAY_SQL} AS local_day
       FROM media_asset
      WHERE archived_at IS NULL AND deleted_at IS NULL AND captured_at IS NOT NULL
        ${keyset}
      ORDER BY captured_at DESC, asset_id DESC
      LIMIT ?`,
    bind
  );
  const filled = rows.length > request.limit;
  const page = (filled ? rows.slice(0, request.limit) : rows).map(toRow);
  const last = page.at(-1);
  return {
    assets: page,
    sections: sliceSections(page),
    ...(filled && last
      ? {
          nextCursor: {
            capturedAt: last.capturedAt,
            assetId: last.assetId,
          },
        }
      : {}),
  };
}

function toRow(row: PageRow): TimelineRow {
  return {
    assetId: row.asset_id,
    contentId: row.content_id,
    kind: row.kind,
    capturedAt: row.captured_at,
    tzOffsetMin: row.tz_offset_min,
    localDay: row.local_day,
  };
}

/**
 * The day boundaries this page crosses, in page order.
 *
 * Derived from the rows the page already holds, so a header costs nothing:
 * asking SQLite for the boundaries separately would be a second read of the
 * same rows, and asking it for ALL of them would be the fold this module
 * exists to delete.
 *
 * KEYED BY DAY, not by adjacency. The page is ordered by `captured_at`, so two
 * rows of one local day can be separated by a row from another when their
 * offsets differ — near a zone change, or a flight. Emitting a second header
 * for a day already on screen is the visible failure that would cause.
 */
function sliceSections(rows: readonly TimelineRow[]): TimelineSectionSlice[] {
  const byDay = new Map<string, TimelineSectionSlice>();
  for (const row of rows) {
    const existing = byDay.get(row.localDay);
    if (existing) {
      existing.assetIds.push(row.assetId);
      continue;
    }
    byDay.set(row.localDay, {
      day: row.localDay,
      month: row.localDay.slice(0, 7),
      assetIds: [row.assetId],
    });
  }
  return [...byDay.values()];
}

export interface TimelineBucket {
  month: string;
  count: number;
}

/**
 * How many captures each month holds, newest month first.
 *
 * This is the scrubber's data — what a member drags to jump two years back —
 * and it is the one query in the timeline that looks at the whole library.
 * It costs ONE ROW PER MONTH because it is a `GROUP BY` over the indexed
 * expression: SQLite walks the index and aggregates, and the table is never
 * touched. Thirty-six rows for three years.
 */
export function timelineBuckets(driver: SeatSqliteDriver): TimelineBucket[] {
  return driver
    .all<{ month: string; n: number }>(
      `SELECT substr(${LOCAL_DAY_SQL}, 1, 7) AS month, count(*) AS n
         FROM media_asset
        WHERE archived_at IS NULL AND deleted_at IS NULL AND captured_at IS NOT NULL
        GROUP BY month
        ORDER BY month DESC`
    )
    .map((row) => ({ month: row.month, count: row.n }));
}
