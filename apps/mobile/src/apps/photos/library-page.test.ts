// THE LIBRARY WALK, RED FIRST (#996, R8 and W5-D1).
//
// The engine's snapshot used to be seven whole-table reads at `limit: 100_000`
// joined by five JavaScript `Map`s. The claim here is that one statement
// answers the same thing, and the three ways that could go wrong quietly:
//
//   1. THE KEYSET MUST BE TOTAL. An asset with no `captured_at` is ordinary —
//      an import with no EXIF date — and a walk keyed on a nullable column
//      stops dead at the first one, losing every row behind it in silence.
//   2. THE LIBRARY IS NOT THE TIMELINE. Archived and trashed assets are in this
//      answer on purpose: `PhotoStateView` draws them and
//      `photos-library-counts.ts` counts them.
//   3. THE STAR IS DERIVED (#916). No flags scheme, or no `starred` concept, is
//      an honest empty set — not a missing join that throws.

import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  FLAGS_SCHEME_URI,
  photoLibraryPage,
  starredConceptId,
  STARRED_NOTATION,
} from "./library-page";

class SeatDriver {
  constructor(private readonly db: DatabaseSync) {}
  run(sql: string, bind: readonly unknown[] = []): void {
    this.db.prepare(sql).run(...(bind as never[]));
  }
  all<T extends object>(sql: string, bind: readonly unknown[] = []): T[] {
    return (this.db.prepare(sql).all(...(bind as never[])) as T[]).map(
      (row) => ({ ...row })
    );
  }
  exec(sql: string): void {
    this.db.exec(sql);
  }
  close(): void {
    this.db.close();
  }
}

/** The seat's tables, as the vault builds the ones this statement touches. */
function seat(): SeatDriver {
  const driver = new SeatDriver(new DatabaseSync(":memory:"));
  driver.exec(`
    CREATE TABLE media_asset (
      asset_id TEXT PRIMARY KEY, content_id TEXT NOT NULL, kind TEXT NOT NULL,
      title TEXT, captured_at TEXT, tz_offset_min INTEGER,
      capture_group_id TEXT, place_id TEXT, width INTEGER, height INTEGER,
      duration_s INTEGER, exif_json TEXT, archived_at TEXT, deleted_at TEXT,
      purge_at TEXT, created_at TEXT NOT NULL);
    CREATE TABLE core_content_item (
      content_id TEXT PRIMARY KEY, content_uri TEXT NOT NULL,
      sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL, deleted_at TEXT,
      purge_at TEXT, created_at TEXT NOT NULL);
    CREATE TABLE core_content_derivative (
      derivative_id TEXT PRIMARY KEY, content_id TEXT NOT NULL,
      variant TEXT NOT NULL, text_content TEXT);
    CREATE TABLE media_asset_phash (asset_id TEXT PRIMARY KEY, phash TEXT);
    CREATE TABLE core_tag (
      tag_id TEXT PRIMARY KEY, target_type TEXT NOT NULL,
      target_id TEXT NOT NULL, concept_id TEXT NOT NULL);
    CREATE TABLE core_concept (
      concept_id TEXT PRIMARY KEY, scheme_id TEXT NOT NULL, notation TEXT);
    CREATE TABLE core_concept_scheme (scheme_id TEXT PRIMARY KEY, uri TEXT);
  `);
  return driver;
}

function addAsset(
  driver: SeatDriver,
  id: string,
  values: Partial<{
    capturedAt: string | null;
    archivedAt: string | null;
    deletedAt: string | null;
    title: string;
  }> = {}
): void {
  driver.run(
    `INSERT INTO core_content_item
       (content_id, content_uri, sha256, byte_size, created_at)
     VALUES (?, 'cas:x', ?, 10, '2024-01-01T00:00:00Z')`,
    [`c-${id}`, id.padEnd(64, "0")]
  );
  driver.run(
    `INSERT INTO media_asset
       (asset_id, content_id, kind, title, captured_at, archived_at,
        deleted_at, created_at)
     VALUES (?, ?, 'photo', ?, ?, ?, ?, '2024-01-01T00:00:00Z')`,
    [
      id,
      `c-${id}`,
      values.title ?? null,
      values.capturedAt === undefined
        ? "2024-06-01T00:00:00Z"
        : values.capturedAt,
      values.archivedAt ?? null,
      values.deletedAt ?? null,
    ]
  );
}

function walk(driver: SeatDriver, concept?: string): string[] {
  const seen: string[] = [];
  let after = undefined;
  for (let page = 0; page < 20; page += 1) {
    const result: ReturnType<typeof photoLibraryPage> = photoLibraryPage(
      driver,
      concept,
      { limit: 2, ...(after ? { after } : {}) }
    );
    seen.push(...result.rows.map((row) => row.asset_id));
    if (!result.next) break;
    after = result.next;
  }
  return seen;
}

describe("the photo library, joined in SQLite", () => {
  it("walks every asset exactly once, dateless ones included", () => {
    const driver = seat();
    try {
      addAsset(driver, "a1");
      // THE ROW A NULLABLE KEYSET WOULD LOSE, and everything behind it.
      addAsset(driver, "a2", { capturedAt: null });
      addAsset(driver, "a3");
      addAsset(driver, "a4", { capturedAt: null });
      addAsset(driver, "a5");
      expect(walk(driver)).toStrictEqual(["a1", "a2", "a3", "a4", "a5"]);
    } finally {
      driver.close();
    }
  });

  it("keeps archived and trashed assets — the library is not the timeline", () => {
    const driver = seat();
    try {
      addAsset(driver, "live");
      addAsset(driver, "put-away", { archivedAt: "2024-07-01T00:00:00Z" });
      addAsset(driver, "binned", { deletedAt: "2024-07-01T00:00:00Z" });
      expect([...walk(driver)].sort()).toStrictEqual([
        "binned",
        "live",
        "put-away",
      ]);
    } finally {
      driver.close();
    }
  });

  it("falls back to the bytes' created_at when a capture has no date", () => {
    const driver = seat();
    try {
      addAsset(driver, "a1", { capturedAt: null });
      const [row] = photoLibraryPage(driver, undefined, { limit: 1 }).rows;
      expect(row?.captured_at).toBeNull();
      expect(row?.captured_key).toBe("2024-01-01T00:00:00Z");
    } finally {
      driver.close();
    }
  });

  it("reads the authored title off the ASSET, where R20(b) put it", () => {
    const driver = seat();
    try {
      addAsset(driver, "a1", { title: "Ferry crossing" });
      const [row] = photoLibraryPage(driver, undefined, { limit: 1 }).rows;
      expect(row?.title).toBe("Ferry crossing");
    } finally {
      driver.close();
    }
  });

  it("marks the starred asset, and only it", () => {
    const driver = seat();
    try {
      addAsset(driver, "a1");
      addAsset(driver, "a2");
      driver.run(
        `INSERT INTO core_concept_scheme (scheme_id, uri) VALUES ('s1', ?)`,
        [FLAGS_SCHEME_URI]
      );
      driver.run(
        `INSERT INTO core_concept (concept_id, scheme_id, notation)
         VALUES ('k1', 's1', ?)`,
        [STARRED_NOTATION]
      );
      driver.run(
        `INSERT INTO core_tag (tag_id, target_type, target_id, concept_id)
         VALUES ('t1', 'media.asset', 'a2', 'k1')`
      );
      const concept = starredConceptId(driver);
      expect(concept).toBe("k1");
      const rows = photoLibraryPage(driver, concept, { limit: 10 }).rows;
      expect(rows.find((row) => row.asset_id === "a1")?.starred).toBe(0);
      expect(rows.find((row) => row.asset_id === "a2")?.starred).toBe(1);
    } finally {
      driver.close();
    }
  });

  it("a vault that has never starred anything is an empty set, not a throw", () => {
    const driver = seat();
    try {
      addAsset(driver, "a1");
      expect(starredConceptId(driver)).toBeUndefined();
      const rows = photoLibraryPage(driver, undefined, { limit: 10 }).rows;
      expect(rows[0]?.starred).toBe(0);
    } finally {
      driver.close();
    }
  });

  it("carries the thumbhash and the phash without multiplying the row", () => {
    const driver = seat();
    try {
      addAsset(driver, "a1");
      driver.run(
        `INSERT INTO core_content_derivative
           (derivative_id, content_id, variant, text_content)
         VALUES ('d1', 'c-a1', 'thumbhash', 'HASH')`
      );
      // A second derivative that must NOT duplicate the asset row.
      driver.run(
        `INSERT INTO core_content_derivative
           (derivative_id, content_id, variant, text_content)
         VALUES ('d2', 'c-a1', 'text', 'body')`
      );
      driver.run(
        `INSERT INTO media_asset_phash (asset_id, phash) VALUES ('a1', 'PH')`
      );
      const rows = photoLibraryPage(driver, undefined, { limit: 10 }).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.thumbhash).toBe("HASH");
      expect(rows[0]?.phash).toBe("PH");
    } finally {
      driver.close();
    }
  });
});
