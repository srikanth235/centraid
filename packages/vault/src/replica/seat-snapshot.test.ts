// THE CANARY (#996, ruling R4).
//
// A snapshot test that reads `sqlite_schema` and finds no private table proves
// only that the CATALOG is clean. P4's control run is the reason that is not
// enough: drop the private tables with `secure_delete` off and no final
// `VACUUM`, and ten planted credential canaries are still readable in 4,360
// freed pages while the catalog already reads clean. So every assertion here
// that matters is over the FILE'S BYTES.

import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { PRIVATE_TABLE_NAMES } from "../schema/private-tables.js";
import { beginReplicaCommit, endReplicaCommit } from "./change-log.js";
import {
  buildSeatSnapshot,
  fileContains,
  namesPrivateTable,
} from "./seat-snapshot.js";

const CANARY = "CANARY-996-never-leaves-the-gateway";
const FTS_CANARY = "CANARY-996-searchable-and-retained";

let dir: string | undefined;
let taken = 0;

function scratch(): string {
  dir ??= tempDirSync("seat-snapshot-");
  taken += 1;
  return path.join(dir, `snapshot-${taken}.db`);
}

/** A vault with a private canary planted and one retained FTS row. */
function seeded(): VaultDb {
  const db = openVaultDb();
  db.vault.exec("BEGIN");
  const handle = beginReplicaCommit(db.vault, { producer: "test" });
  db.vault
    .prepare(
      `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
       VALUES ('p1', 'person', 'Owner', '2026-01-01T00:00:00.000Z',
               '2026-01-01T00:00:00.000Z')`
    )
    .run();
  db.vault
    .prepare(
      `INSERT INTO access_device (device_id, owner_party_id, name, enrolled_at)
       VALUES ('d1', 'p1', 'Phone', '2026-01-01T00:00:00.000Z')`
    )
    .run();
  // The canary lives in a PRIVATE table with a replicated parent — the split
  // this whole list exists to make possible.
  db.vault
    .prepare(
      `INSERT INTO access_device_secret (device_id, public_key, sync_cursor)
       VALUES ('d1', ?, NULL)`
    )
    .run(CANARY);
  // A retained FTS row, so "absent from retained FTS content" has something to
  // be true about.
  db.vault
    .prepare(
      `INSERT INTO core_content_item
         (content_id, content_uri, sha256, byte_size, created_at)
       VALUES ('c1', 'data:text/plain,x', ?, 1, '2026-01-01T00:00:00.000Z')`
    )
    .run("0".repeat(64));
  db.vault
    .prepare(
      `INSERT INTO core_document
         (document_id, title, current_content_id, created_at, updated_at)
       VALUES ('doc1', ?, 'c1', '2026-01-01T00:00:00.000Z',
               '2026-01-01T00:00:00.000Z')`
    )
    .run(FTS_CANARY);
  endReplicaCommit(db.vault, handle);
  db.vault.exec("COMMIT");
  return db;
}

describe("the sanitised seat snapshot", () => {
  test("the private canary is absent from the file's BYTES", () => {
    const db = seeded();
    const source = scratch();
    try {
      // Present before, or the assertion after it means nothing.
      db.vault.exec(`VACUUM INTO '${source}'`);
      expect(fileContains(source, CANARY)).toBe(true);

      const destination = scratch();
      const result = buildSeatSnapshot(db.vault, destination);
      expect(fileContains(destination, CANARY)).toBe(false);
      expect(result.droppedTables).toContain("access_device_secret");
      expect(result.bytes).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test("no private table, and no trigger except FTS sync, survives", () => {
    const db = seeded();
    try {
      const destination = scratch();
      buildSeatSnapshot(db.vault, destination);
      // Opened RAW, the way a seat opens it: no migration ladder, no
      // app-defined SQL function, no trigger regeneration. If the snapshot
      // needed any of those it would not be a snapshot.
      const seat = new DatabaseSync(destination);
      try {
        const tables = (
          seat
            .prepare(`SELECT name FROM sqlite_schema WHERE type = 'table'`)
            .all() as { name: string }[]
        ).map((row) => row.name);
        expect(
          tables.filter((name) => PRIVATE_TABLE_NAMES.has(name))
        ).toStrictEqual([]);
        // The identity projection stayed, so `origin_device_id` still resolves.
        expect(tables).toContain("access_device");

        const triggers = seat
          .prepare(`SELECT name, sql FROM sqlite_schema WHERE type = 'trigger'`)
          .all() as { name: string; sql: string }[];
        expect(triggers.length).toBeGreaterThan(0);
        expect(
          triggers.filter((trigger) => !/\bfts_/u.test(trigger.sql))
        ).toStrictEqual([]);
        // No object at all still names a private table.
        const objects = (
          seat
            .prepare(`SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL`)
            .all() as { sql: string }[]
        ).filter((object) => namesPrivateTable(object.sql));
        expect(objects).toStrictEqual([]);
      } finally {
        seat.close();
      }
    } finally {
      db.close();
    }
  });

  test("the log is truncated and its cursor kept", () => {
    const db = seeded();
    try {
      const destination = scratch();
      const result = buildSeatSnapshot(db.vault, destination);
      expect(result.seq).toBeGreaterThan(0);
      // Opened RAW, the way a seat opens it: no migration ladder, no
      // app-defined SQL function, no trigger regeneration. If the snapshot
      // needed any of those it would not be a snapshot.
      const seat = new DatabaseSync(destination);
      try {
        expect(
          (
            seat.prepare(`SELECT COUNT(*) AS n FROM replica_log`).get() as {
              n: number;
            }
          ).n
        ).toBe(0);
        // The cursor is what makes a file copy a bootstrap rather than a
        // restart: the seat tails from here, not from zero.
        expect(
          (
            seat
              .prepare(
                `SELECT floor_seq, epoch FROM replica_meta WHERE singleton = 1`
              )
              .get() as { floor_seq: number; epoch: string }
          ).floor_seq
        ).toBe(result.seq);
      } finally {
        seat.close();
      }
    } finally {
      db.close();
    }
  });

  test("retained FTS content still answers, and carries no private text", () => {
    const db = seeded();
    try {
      const destination = scratch();
      buildSeatSnapshot(db.vault, destination);
      // Opened RAW, the way a seat opens it: no migration ladder, no
      // app-defined SQL function, no trigger regeneration. If the snapshot
      // needed any of those it would not be a snapshot.
      const seat = new DatabaseSync(destination);
      try {
        // The index came across whole: the seat searches without rebuilding.
        expect(
          seat
            .prepare(
              `SELECT document_id FROM fts_core_document
                WHERE fts_core_document MATCH 'searchable'`
            )
            .all()
        ).toHaveLength(1);
        // And nothing private is in it. No `fts_` sits over a private column
        // today, so this is unreachable by construction and kept for the first
        // index that does.
        expect(
          seat
            .prepare(
              `SELECT document_id FROM fts_core_document
                WHERE fts_core_document MATCH 'gateway'`
            )
            .all()
        ).toStrictEqual([]);
      } finally {
        seat.close();
      }
    } finally {
      db.close();
    }
  });
});
