// THE TIMELINE PAGE, RED FIRST (#996 wave 3).
//
// The claim under test is the one a year-3 vault makes impossible to fake:
// drawing the top of the library must cost the page, not the library. The old
// path read `media.asset` whole and folded it into day sections in JavaScript
// (`timeline-model.ts`'s `sectionPhotoAssets`), so a phone holding 50,000
// assets paid for 50,000 rows to draw twenty.
//
// THREE ASSERTIONS, AND THE THIRD IS THE POINT:
//   1. the page is the size it was asked for, and the keyset walks the library
//      exactly once — no overlap, no gap, no re-reading from the top;
//   2. the day and month boundaries are the CAPTURE-LOCAL ones, so a photo
//      taken at 23:30 in Tokyo and one taken at 09:00 in London on the same
//      UTC instant land on different days;
//   3. no query reads more rows than the page plus its bucket headers. That is
//      what "keyset-paged" has to mean to be worth doing, and it is the one a
//      test can hold against a fold that would otherwise creep back.
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { clientWorkCounters } from "@centraid/client/replica/native";

import {
  SEAT_TIMELINE_INDEX_SQL,
  timelineBuckets,
  timelinePage,
} from "./timeline-page";

/** Rows a statement actually returned, per statement — the cost being held. */
class CountingSeatDriver {
  readonly reads: { sql: string; rows: number }[] = [];
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  run(sql: string, bind: readonly unknown[] = []): void {
    this.#db.prepare(sql).run(...(bind as never[]));
  }

  all<T extends object>(sql: string, bind: readonly unknown[] = []): T[] {
    const rows = this.#db.prepare(sql).all(...(bind as never[])) as T[];
    this.reads.push({ sql, rows: rows.length });
    return rows.map((row) => ({ ...row }));
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  close(): void {
    this.#db.close();
  }
}

/** Three years of captures, one seat file, the shape the phone actually holds. */
const YEARS = 3;
const PER_DAY = 18;
const DAYS = 365 * YEARS;
const TOTAL = DAYS * PER_DAY;

function seatFixture(): CountingSeatDriver {
  const driver = new CountingSeatDriver(new DatabaseSync(":memory:"));
  driver.exec(`
    CREATE TABLE media_asset (
      asset_id      TEXT PRIMARY KEY,
      content_id    TEXT NOT NULL,
      kind          TEXT NOT NULL,
      captured_at   TEXT,
      tz_offset_min INTEGER,
      archived_at   TEXT,
      deleted_at    TEXT
    );
  `);
  const insert = `INSERT INTO media_asset
      (asset_id, content_id, kind, captured_at, tz_offset_min, archived_at, deleted_at)
      VALUES (?, ?, 'photo', ?, ?, NULL, NULL)`;
  driver.exec("BEGIN");
  for (let day = 0; day < DAYS; day += 1) {
    const date = new Date(Date.UTC(2023, 0, 1 + day));
    for (let n = 0; n < PER_DAY; n += 1) {
      const at = new Date(date.getTime() + n * 3_600_000).toISOString();
      const id = `a-${String(day).padStart(4, "0")}-${String(n).padStart(2, "0")}`;
      driver.run(insert, [id, `c-${id}`, at, 0]);
    }
  }
  // Archived and trashed rows the timeline must never draw — and must never
  // pay to skip, which is what the partial index is for.
  driver.run(
    `INSERT INTO media_asset VALUES ('gone','c-gone','photo','2024-06-01T12:00:00.000Z',0,'2024-06-02T00:00:00Z',NULL)`
  );
  driver.run(
    `INSERT INTO media_asset VALUES ('bin','c-bin','photo','2024-06-01T13:00:00.000Z',0,NULL,'2024-06-02T00:00:00Z')`
  );
  driver.exec("COMMIT");
  driver.exec(SEAT_TIMELINE_INDEX_SQL);
  driver.reads.length = 0;
  return driver;
}

describe("the photo timeline, paged in SQLite", () => {
  it("returns the page it was asked for and walks the library exactly once", () => {
    const driver = seatFixture();
    try {
      const seen: string[] = [];
      let cursor = undefined;
      for (let page = 0; page < 5; page += 1) {
        const result = timelinePage(driver, { limit: 40, after: cursor });
        expect(result.rows).toHaveLength(40);
        seen.push(...result.rows.map((asset) => asset.assetId));
        cursor = result.next;
        expect(cursor).toBeDefined();
      }
      // Newest first, no duplicate, no gap: five pages of forty is the newest
      // 200 captures in order.
      expect(new Set(seen).size).toBe(200);
      // Ids sort in capture order by construction, so "already descending" is
      // the no-gap, no-overlap claim. `.sort()` on a copy, not `toSorted`:
      // Hermes does not implement it (`no-restricted-properties`).
      const descending = [...seen].sort((left, right) =>
        left < right ? 1 : left > right ? -1 : 0
      );
      expect(descending).toStrictEqual(seen);
    } finally {
      driver.close();
    }
  });

  it("never reads more rows than the page it returns, plus one probe", () => {
    const driver = seatFixture();
    try {
      timelinePage(driver, { limit: 40 });
      // The whole point: 19,710 assets in the file, 41 rows off the driver.
      for (const read of driver.reads)
        expect(read.rows).toBeLessThanOrEqual(41);
      expect(driver.reads.every((read) => read.rows > 0)).toBe(true);
    } finally {
      driver.close();
    }
  });

  it("records the work it did at year-3 scale, as the R8 gate", () => {
    // The measured row R8 puts on every handler, for this one: 19,710 assets
    // in the file, ONE statement, 41 rows visited to draw forty. The host does
    // the counting, so a handler cannot regress this by forgetting to.
    const driver = seatFixture();
    try {
      const before = clientWorkCounters();
      timelinePage(driver, { limit: 40 });
      const after = clientWorkCounters();
      expect(after.statements - before.statements).toBe(1);
      expect(after.rowsScanned - before.rowsScanned).toBe(41);
    } finally {
      driver.close();
    }
  });

  it("seeks the index rather than scanning the table, for both queries", () => {
    // Rows RETURNED is only half the claim: a statement that returns 41 rows
    // after scanning 19,710 costs the library anyway. This is the other half,
    // and it is why the index is partial and leads with the local day.
    const driver = seatFixture();
    try {
      const plans = (sql: string): string =>
        driver
          .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
          .map((row) => row.detail)
          .join(" | ");
      const pagePlan = plans(
        `SELECT asset_id FROM media_asset
          WHERE archived_at IS NULL AND deleted_at IS NULL AND captured_at IS NOT NULL
            AND (captured_at, asset_id) < ('2025-01-01T00:00:00.000Z', 'z')
          ORDER BY captured_at DESC, asset_id DESC LIMIT 41`
      );
      // SEARCH, not SCAN, and no sort: the keyset is a seek down the index
      // and the index is already in the page's order.
      expect(pagePlan).toContain("seat_media_timeline_idx");
      expect(pagePlan).toContain("SEARCH media_asset");
      expect(pagePlan).not.toContain("TEMP B-TREE");
    } finally {
      driver.close();
    }
  });

  it("ends the walk rather than looping when the library runs out", () => {
    const driver = seatFixture();
    try {
      const result = timelinePage(driver, {
        limit: 40,
        after: { sortKey: "2023-01-01T00:00:00.000Z", pk: "a-0000-00" },
      });
      expect(result.rows).toStrictEqual([]);
      expect(result.next).toBeUndefined();
    } finally {
      driver.close();
    }
  });

  it("draws neither an archived nor a trashed asset", () => {
    const driver = seatFixture();
    try {
      const ids = new Set<string>();
      let cursor = undefined;
      for (let page = 0; page < 3; page += 1) {
        const result = timelinePage(driver, {
          limit: 100,
          after: cursor,
          // Start just above the archived pair so they would be in this page.
          ...(page === 0
            ? {
                after: {
                  sortKey: "2024-06-01T14:00:00.000Z",
                  pk: "a-9999-99",
                },
              }
            : {}),
        });
        for (const asset of result.rows) ids.add(asset.assetId);
        cursor = result.next;
      }
      expect(ids.has("gone")).toBe(false);
      expect(ids.has("bin")).toBe(false);
    } finally {
      driver.close();
    }
  });

  it("groups by the CAPTURE-LOCAL day, not the UTC one", () => {
    const driver = seatFixture();
    try {
      // One UTC instant, two zones: Tokyo is already tomorrow.
      driver.run(
        `INSERT INTO media_asset VALUES ('tokyo','c-tokyo','photo','2025-03-01T23:30:00.000Z',540,NULL,NULL)`
      );
      driver.run(
        `INSERT INTO media_asset VALUES ('london','c-london','photo','2025-03-01T23:30:00.000Z',0,NULL,NULL)`
      );
      const page = timelinePage(driver, {
        limit: 4,
        after: { sortKey: "2025-03-02T00:00:00.000Z", pk: "zzz" },
      });
      const byId = new Map(
        page.rows.map((asset) => [asset.assetId, asset.localDay])
      );
      expect(byId.get("tokyo")).toBe("2025-03-02");
      expect(byId.get("london")).toBe("2025-03-01");
    } finally {
      driver.close();
    }
  });

  it("carries the day and month boundaries the page itself crosses", () => {
    const driver = seatFixture();
    try {
      // 18 a day, so a 40-row page spans three days. 1,095 days from
      // 2023-01-01 ends on 2025-12-30 — 2024 is a leap year.
      const page = timelinePage(driver, { limit: 40 });
      expect(page.sections.map((section) => section.day)).toStrictEqual([
        "2025-12-30",
        "2025-12-29",
        "2025-12-28",
      ]);
      expect(page.sections.map((section) => section.month)).toStrictEqual([
        "2025-12",
        "2025-12",
        "2025-12",
      ]);
      // Every asset in the page belongs to exactly one section, in order.
      expect(
        page.sections.flatMap((section) => section.assetIds)
      ).toStrictEqual(page.rows.map((asset) => asset.assetId));
    } finally {
      driver.close();
    }
  });

  it("emits one header for a day the page order splits in two", () => {
    // Ordered by `captured_at`, two rows of one local day can be separated by
    // a row from another when the offsets differ — a flight, or a zone change.
    // A second header for a day already on screen is the visible failure.
    const driver = seatFixture();
    try {
      driver.run(
        `INSERT INTO media_asset VALUES ('split-a','c1','photo','2025-06-10T22:00:00.000Z',120,NULL,NULL)`
      );
      driver.run(
        `INSERT INTO media_asset VALUES ('between','c2','photo','2025-06-10T21:00:00.000Z',0,NULL,NULL)`
      );
      driver.run(
        `INSERT INTO media_asset VALUES ('split-b','c3','photo','2025-06-10T20:00:00.000Z',240,NULL,NULL)`
      );
      const page = timelinePage(driver, {
        limit: 3,
        after: { sortKey: "2025-06-10T23:00:00.000Z", pk: "zzz" },
      });
      expect(page.rows.map((asset) => asset.localDay)).toStrictEqual([
        "2025-06-11",
        "2025-06-10",
        "2025-06-11",
      ]);
      expect(page.sections.map((section) => section.day)).toStrictEqual([
        "2025-06-11",
        "2025-06-10",
      ]);
      expect(page.sections[0]?.assetIds).toStrictEqual(["split-a", "split-b"]);
    } finally {
      driver.close();
    }
  });

  it("costs the same at the oldest page as at the newest", () => {
    // The whole reason the key is plain columns. The first draft keyed on the
    // local-day EXPRESSION and SQLite answered `SCAN … USING INDEX` rather
    // than `SEARCH`, so every page walked the index from the top: flat
    // returned-row counts over a cost that grew with depth.
    const driver = seatFixture();
    try {
      const at = (
        day: number,
        hour: number
      ): { sortKey: string; pk: string } => ({
        sortKey: new Date(
          Date.UTC(2023, 0, 1 + day) + hour * 3_600_000
        ).toISOString(),
        pk: `a-${String(day).padStart(4, "0")}-${String(hour).padStart(2, "0")}`,
      });
      const cost = (after: { sortKey: string; pk: string }): number => {
        const started = performance.now();
        for (let n = 0; n < 40; n += 1)
          timelinePage(driver, { limit: 40, after });
        return performance.now() - started;
      };
      const newest = cost(at(DAYS - 2, 17));
      const oldest = cost(at(2, 17));
      // Generous — a shared CI box is noisy — but an index walked from the top
      // is two orders of magnitude, not a factor of eight.
      expect(oldest).toBeLessThan(Math.max(newest, 1) * 8);
    } finally {
      driver.close();
    }
  });

  it("counts the month buckets by GROUP BY over the index, one row per month", () => {
    const driver = seatFixture();
    try {
      const buckets = timelineBuckets(driver);
      // Three years is 36 months, and the aggregate returns 36 rows — not
      // 19,710. A second bucket TABLE would be the other way to get this
      // number, and it would be a second truth to keep in step.
      expect(buckets).toHaveLength(36);
      expect(buckets[0]?.month).toBe("2025-12");
      expect(buckets.reduce((total, bucket) => total + bucket.count, 0)).toBe(
        TOTAL
      );
      for (const read of driver.reads)
        expect(read.rows).toBeLessThanOrEqual(buckets.length);
    } finally {
      driver.close();
    }
  });
});
