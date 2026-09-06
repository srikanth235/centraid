// THE THREE GATES THE GATEWAY LOG EXISTS TO PASS (#996, W1).
//
// ORACLE - the decoder against SQLite's own applier. The decoder reads a
// binary format `node:sqlite` gives no iterator for, so "we parsed it right"
// cannot be asserted by reading the parser. It is asserted by applying the
// same commit two ways - our JSON rows onto one copy, the native changeset via
// `applyChangeset` onto another - and requiring the two copies to be equal.
//
// CONVERGENCE - a replica copied at seq S and fed S..N equals the gateway at
// the watermark, every table, values not bytes. This is the property the whole
// plane is for, and the only one that catches a decoder that is
// self-consistently wrong.
//
// ATOMICITY - a mutation and its log row commit together; a rollback leaves
// neither; a batch delivered twice lands once; a crash mid-batch is completed
// by the next attempt.

import { describe, expect, test } from "vitest";

import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { replicatedTablesOf } from "../schema/private-tables.js";
import { applyReplicaLog } from "./apply.js";
import { beginReplicaCommit, endReplicaCommit } from "./change-log.js";
import { parseChangeset } from "./changeset.js";
import { readReplicaLog, replicaLogState } from "./log.js";

type Sqlite = VaultDb["vault"];

/** Run `write` inside one captured commit, the way every canonical path does. */
function commit(
  db: VaultDb,
  producer: string,
  write: (vault: Sqlite) => void
): void {
  db.vault.exec("BEGIN");
  const handle = beginReplicaCommit(db.vault, { producer });
  try {
    write(db.vault);
    endReplicaCommit(db.vault, handle);
    db.vault.exec("COMMIT");
  } catch (error) {
    db.vault.exec("ROLLBACK");
    throw error;
  }
}

function scheme(vault: Sqlite, id: string, title = id): void {
  vault
    .prepare(
      `INSERT INTO core_concept_scheme (scheme_id, uri, title, version)
       VALUES (?, ?, ?, '1')`
    )
    .run(id, `urn:${id}`, title);
}

/** Value-level digest of one table, order-independent - the comparator. */
function tableDigest(vault: Sqlite, table: string): string {
  const columns = (
    vault.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]
  ).map((column) => column.name);
  const quoted = columns.map((name) => `quote("${name}")`).join(" || '|' || ");
  const rows = vault
    .prepare(`SELECT ${quoted} AS row FROM "${table}"`)
    .all() as { row: string }[];
  return rows
    .map((row) => row.row)
    .sort()
    .join("\n");
}

describe("the gateway log - capture and decode", () => {
  test("a commit's mutation and its log rows are one transaction", () => {
    const db = openVaultDb();
    try {
      const before = replicaLogState(db.vault).watermark.seq;
      expect(() =>
        commit(db, "test", (vault) => {
          scheme(vault, "kept");
          throw new Error("writer failed");
        })
      ).toThrow("writer failed");
      expect(
        (
          db.vault
            .prepare(
              `SELECT COUNT(*) AS n FROM core_concept_scheme WHERE scheme_id = 'kept'`
            )
            .get() as { n: number }
        ).n
      ).toBe(0);
      expect(replicaLogState(db.vault).watermark.seq).toBe(before);

      commit(db, "test", (vault) => scheme(vault, "landed"));
      const page = readReplicaLog(db.vault);
      expect(
        page.rows.some(
          (row) => row.table === "core_concept_scheme" && row.op === "insert"
        )
      ).toBe(true);
      // A rolled-back commit leaves no gap a reader can see: the landed
      // commit takes position 1, not 2.
      expect(page.rows[0]!.commitSeq).toBe(1);
    } finally {
      db.close();
    }
  });

  test("an update carries the FULL row image, not the columns it touched", () => {
    const db = openVaultDb();
    try {
      commit(db, "test", (vault) => scheme(vault, "s", "Before"));
      const from = replicaLogState(db.vault).watermark;
      commit(db, "test", (vault) =>
        vault
          .prepare(
            `UPDATE core_concept_scheme SET title = ? WHERE scheme_id = 's'`
          )
          .run("After")
      );
      const rows = readReplicaLog(db.vault, { since: from }).rows.filter(
        (row) => row.table === "core_concept_scheme"
      );
      expect(rows).toHaveLength(1);
      const image = rows[0]!.row!;
      expect(rows[0]!.op).toBe("update");
      expect(image["title"]).toBe("After");
      // The statement named ONE column; the image names them all, including
      // the ones the changeset omitted.
      expect(Object.keys(image).sort()).toStrictEqual([
        "created_at",
        "publisher",
        "scheme_id",
        "title",
        "uri",
        "version",
      ]);
      // NULL is a value, not an absence: `publisher` is present and null.
      expect("publisher" in image).toBe(true);
      expect(image["publisher"]).toBeNull();
    } finally {
      db.close();
    }
  });

  test("a no-op update and an insert-then-delete are not recorded at all", () => {
    const db = openVaultDb();
    try {
      commit(db, "test", (vault) => scheme(vault, "s", "Same"));
      const from = replicaLogState(db.vault).watermark;
      commit(db, "test", (vault) =>
        vault
          .prepare(
            `UPDATE core_concept_scheme SET title = title WHERE scheme_id = 's'`
          )
          .run()
      );
      commit(db, "test", (vault) => {
        scheme(vault, "ephemeral");
        vault
          .prepare(
            `DELETE FROM core_concept_scheme WHERE scheme_id = 'ephemeral'`
          )
          .run();
      });
      const rows = readReplicaLog(db.vault, { since: from }).rows.filter(
        (row) => row.table === "core_concept_scheme"
      );
      expect(rows).toStrictEqual([]);
    } finally {
      db.close();
    }
  });

  test("a delete carries the OLD image, and a cascade is its own row", () => {
    const db = openVaultDb();
    try {
      commit(db, "test", (vault) => scheme(vault, "s", "Gone soon"));
      const from = replicaLogState(db.vault).watermark;
      commit(db, "test", (vault) =>
        vault
          .prepare(`DELETE FROM core_concept_scheme WHERE scheme_id = 's'`)
          .run()
      );
      const rows = readReplicaLog(db.vault, { since: from }).rows;
      const own = rows.find((row) => row.table === "core_concept_scheme")!;
      expect(own.op).toBe("delete");
      expect(own.row!["title"]).toBe("Gone soon");
      expect(own.indirect).toBe(false);
      // `core_entity`'s row goes with it, as its own row and flagged indirect
      // - a seat has no triggers, so a cascade it is not told about is a row
      // it would keep forever.
      const cascaded = rows.find((row) => row.table === "core_entity");
      expect(cascaded?.op).toBe("delete");
      expect(cascaded?.indirect).toBe(true);
    } finally {
      db.close();
    }
  });

  test("a primary-key change is a delete and an insert, never an update", () => {
    const db = openVaultDb();
    try {
      commit(db, "test", (vault) => scheme(vault, "old-id", "Renamed"));
      const from = replicaLogState(db.vault).watermark;
      commit(db, "test", (vault) => {
        // `foreign_keys` cannot be changed inside a transaction; deferring is
        // how a key is re-pointed and its parent moved in one commit.
        vault.exec("PRAGMA defer_foreign_keys = ON");
        vault
          .prepare(
            `UPDATE core_entity SET entity_id = 'new-id' WHERE entity_id = 'old-id'`
          )
          .run();
        vault
          .prepare(
            `UPDATE core_concept_scheme SET scheme_id = 'new-id' WHERE scheme_id = 'old-id'`
          )
          .run();
      });
      const rows = readReplicaLog(db.vault, { since: from }).rows.filter(
        (row) => row.table === "core_concept_scheme"
      );
      expect(rows.map((row) => row.op).sort()).toStrictEqual([
        "delete",
        "insert",
      ]);
      expect(rows.find((row) => row.op === "delete")!.primaryKey).toStrictEqual(
        ["old-id"]
      );
      expect(rows.find((row) => row.op === "insert")!.primaryKey).toStrictEqual(
        ["new-id"]
      );
    } finally {
      db.close();
    }
  });

  test("a private table never reaches the log, and NULL travels as NULL", () => {
    const db = openVaultDb();
    try {
      const salt = new Uint8Array(32).fill(7);
      commit(db, "test", (vault) => {
        vault
          .prepare(
            `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
             VALUES ('p1', 'person', 'Owner', '2026-01-01T00:00:00.000Z',
                     '2026-01-01T00:00:00.000Z')`
          )
          .run();
        vault
          .prepare(
            `INSERT INTO access_device (device_id, owner_party_id, name, enrolled_at)
             VALUES ('d1', 'p1', 'Device', '2026-01-01T00:00:00.000Z')`
          )
          .run();
        vault
          .prepare(
            `INSERT INTO blob_device_wrap_key (device_id, key_epoch, salt, updated_at)
             VALUES ('d1', ?, ?, '2026-01-01T00:00:00.000Z')`
          )
          .run(3, salt);
      });
      const rows = readReplicaLog(db.vault).rows;
      // The wrap key is on the private list, so it is not in the log at all -
      // the property R3 is actually about.
      expect(
        rows.filter((row) => row.table === "blob_device_wrap_key")
      ).toStrictEqual([]);
      // The device IDENTITY did travel, with its nullable column present.
      const device = rows.find((row) => row.table === "access_device")!;
      expect(device.row!["platform"]).toBeNull();
      expect("platform" in device.row!).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe("the gateway log - the oracle", () => {
  /**
   * The differential test. One vault writes a commit; the same commit is
   * applied to two copies - one from the log's JSON rows through the real
   * applier, one from the native changeset through `applyChangeset` - and the
   * two copies must agree, table by table, on values.
   */
  function oracle(write: (vault: Sqlite) => void, tables: string[]): number {
    const origin = openVaultDb();
    const viaJson = openVaultDb();
    const viaNative = openVaultDb();
    try {
      // A session over the whole file, beside the log's own capture, so the
      // native side sees exactly what the decoder saw.
      origin.vault.exec("BEGIN");
      const handle = beginReplicaCommit(origin.vault, { producer: "oracle" });
      const native = origin.vault.createSession();
      write(origin.vault);
      const changeset = native.changeset();
      endReplicaCommit(origin.vault, handle);
      origin.vault.exec("COMMIT");
      native.close();

      const rows = readReplicaLog(origin.vault, { limit: 10_000 }).rows.filter(
        (row) => tables.includes(row.table)
      );
      expect(rows.length).toBeGreaterThan(0);
      applyReplicaLog(viaJson.vault, rows, { expectedEpoch: rows[0]!.epoch });

      viaNative.vault.exec("PRAGMA foreign_keys = OFF");
      viaNative.vault.applyChangeset(changeset, {
        filter: (table: string) => tables.includes(table),
        // SQLITE_CHANGESET_REPLACE: the copies start from the same bootstrap,
        // so a conflict here is a row both sides already agree on.
        onConflict: () => 1,
      });

      for (const table of tables) {
        expect(
          tableDigest(viaJson.vault, table),
          `${table}: JSON apply vs native applyChangeset`
        ).toBe(tableDigest(viaNative.vault, table));
        expect(
          tableDigest(viaJson.vault, table),
          `${table}: JSON apply vs the origin`
        ).toBe(tableDigest(origin.vault, table));
      }
      return rows.length;
    } finally {
      origin.close();
      viaJson.close();
      viaNative.close();
    }
  }

  test("inserts", () => {
    expect(
      oracle(
        (vault) => {
          scheme(vault, "a", "A");
          scheme(vault, "b", "B");
        },
        ["core_concept_scheme"]
      )
    ).toBe(2);
  });

  test("an omitted-column update", () => {
    expect(
      oracle(
        (vault) => {
          scheme(vault, "a", "A");
          vault
            .prepare(
              `UPDATE core_concept_scheme SET publisher = 'p' WHERE scheme_id = 'a'`
            )
            .run();
        },
        ["core_concept_scheme"]
      )
      // Insert then update collapses to ONE change: the session's doing.
    ).toBe(1);
  });

  test("a delete beside an insert", () => {
    expect(
      oracle(
        (vault) => {
          scheme(vault, "a", "A");
          scheme(vault, "b", "B");
          vault
            .prepare(`DELETE FROM core_concept_scheme WHERE scheme_id = 'a'`)
            .run();
        },
        ["core_concept_scheme"]
      )
      // 'a' was inserted and deleted in the same commit: not a change at all.
    ).toBe(1);
  });

  test("a derivation trigger's own write", () => {
    // `core_entity` is written by the membership trigger, never by the
    // statement - so this is the oracle over rows no writer named.
    expect(
      oracle(
        (vault) => {
          scheme(vault, "a", "A");
          scheme(vault, "b", "B");
        },
        ["core_entity"]
      )
    ).toBe(2);
  });

  test("the changeset the parser reads is the one SQLite wrote", () => {
    const db = openVaultDb();
    try {
      db.vault.exec("BEGIN");
      const session = db.vault.createSession({ table: "core_concept_scheme" });
      scheme(db.vault, "a", "A");
      db.vault
        .prepare(
          `UPDATE core_concept_scheme SET title = 'B' WHERE scheme_id = 'a'`
        )
        .run();
      const changes = parseChangeset(session.changeset());
      session.close();
      db.vault.exec("COMMIT");
      // Two statements, ONE change: the collapse is the session's, which is
      // why the log carries one row per (table, key) per commit.
      expect(changes).toHaveLength(1);
      expect(changes[0]!.op).toBe("insert");
      expect(changes[0]!.table).toBe("core_concept_scheme");
      expect(changes[0]!.primaryKeyFlags.filter(Boolean)).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

describe("the gateway log - convergence and atomicity", () => {
  test("a copy at S fed S..N equals the gateway at the watermark", () => {
    const origin = openVaultDb();
    const seat = openVaultDb();
    try {
      const from = replicaLogState(origin.vault).floor;
      commit(origin, "seed", (vault) => {
        scheme(vault, "one", "One");
        scheme(vault, "two", "Two");
      });
      commit(origin, "edit", (vault) => {
        vault
          .prepare(
            `UPDATE core_concept_scheme SET title = 'One!' WHERE scheme_id = 'one'`
          )
          .run();
        vault
          .prepare(`DELETE FROM core_concept_scheme WHERE scheme_id = 'two'`)
          .run();
      });
      commit(origin, "edit", (vault) => scheme(vault, "three", "Three"));

      const page = readReplicaLog(origin.vault, { since: from, limit: 10_000 });
      const result = applyReplicaLog(seat.vault, page.rows, {
        expectedEpoch: page.rows[0]!.epoch,
      });
      expect(result.commits).toBe(3);

      // EVERY replicated table, not only the ones the test wrote: a decoder
      // that drops a table is exactly the failure a narrow assertion misses.
      const drift = replicatedTablesOf(origin.vault).filter(
        (table) =>
          tableDigest(origin.vault, table) !== tableDigest(seat.vault, table)
      );
      expect(drift).toStrictEqual([]);
      expect(
        seat.vault.prepare(`PRAGMA foreign_key_check`).all()
      ).toStrictEqual([]);
    } finally {
      origin.close();
      seat.close();
    }
  });

  test("FTS answers the same query on both sides", () => {
    const origin = openVaultDb();
    const seat = openVaultDb();
    try {
      const from = replicaLogState(origin.vault).floor;
      commit(origin, "seed", (vault) => {
        vault
          .prepare(
            `INSERT INTO core_content_item
               (content_id, content_uri, sha256, byte_size, created_at)
             VALUES ('c1', 'data:text/plain,body', ?, 4,
                     '2026-01-01T00:00:00.000Z')`
          )
          .run("0".repeat(64));
        vault
          .prepare(
            `INSERT INTO core_document
               (document_id, title, current_content_id, created_at, updated_at)
             VALUES ('d1', 'Convergent title', 'c1',
                     '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
          )
          .run();
      });
      const page = readReplicaLog(origin.vault, { since: from, limit: 10_000 });
      applyReplicaLog(seat.vault, page.rows, {
        expectedEpoch: page.rows[0]!.epoch,
      });
      const ask = (vault: Sqlite): unknown[] =>
        vault
          .prepare(
            `SELECT document_id FROM fts_core_document
              WHERE fts_core_document MATCH 'convergent' ORDER BY document_id`
          )
          .all();
      // Query-result parity, never shadow bytes: an index is not data, and
      // the two sides build it independently.
      expect(ask(origin.vault)).toHaveLength(1);
      expect(ask(seat.vault)).toStrictEqual(ask(origin.vault));
    } finally {
      origin.close();
      seat.close();
    }
  });

  test("duplicate delivery lands once", () => {
    const origin = openVaultDb();
    const seat = openVaultDb();
    try {
      const from = replicaLogState(origin.vault).floor;
      commit(origin, "seed", (vault) => scheme(vault, "s", "Once"));
      const rows = readReplicaLog(origin.vault, {
        since: from,
        limit: 10_000,
      }).rows;
      applyReplicaLog(seat.vault, rows, { expectedEpoch: rows[0]!.epoch });
      const after = tableDigest(seat.vault, "core_concept_scheme");
      applyReplicaLog(seat.vault, rows, { expectedEpoch: rows[0]!.epoch });
      applyReplicaLog(seat.vault, rows, { expectedEpoch: rows[0]!.epoch });
      expect(tableDigest(seat.vault, "core_concept_scheme")).toBe(after);
      expect(tableDigest(seat.vault, "core_concept_scheme")).toBe(
        tableDigest(origin.vault, "core_concept_scheme")
      );
    } finally {
      origin.close();
      seat.close();
    }
  });

  test("a crash mid-batch is completed by the next attempt", () => {
    const origin = openVaultDb();
    const seat = openVaultDb();
    try {
      const from = replicaLogState(origin.vault).floor;
      commit(origin, "seed", (vault) => scheme(vault, "a", "A"));
      commit(origin, "seed", (vault) => scheme(vault, "b", "B"));
      commit(origin, "seed", (vault) => scheme(vault, "c", "C"));
      const rows = readReplicaLog(origin.vault, {
        since: from,
        limit: 10_000,
      }).rows;
      const epoch = rows[0]!.epoch;
      // The crash: only the first commit's rows arrive.
      const firstCommit = rows[0]!.commitSeq;
      const partial = rows.filter((row) => row.commitSeq === firstCommit);
      expect(
        applyReplicaLog(seat.vault, partial, { expectedEpoch: epoch }).commits
      ).toBe(1);
      expect(tableDigest(seat.vault, "core_concept_scheme")).not.toBe(
        tableDigest(origin.vault, "core_concept_scheme")
      );
      // The next attempt re-sends from the last durable position and finishes.
      applyReplicaLog(seat.vault, rows, { expectedEpoch: epoch });
      expect(tableDigest(seat.vault, "core_concept_scheme")).toBe(
        tableDigest(origin.vault, "core_concept_scheme")
      );
    } finally {
      origin.close();
      seat.close();
    }
  });

  test("a row from another epoch is refused, not silently skipped", () => {
    const origin = openVaultDb();
    const seat = openVaultDb();
    try {
      commit(origin, "seed", (vault) => scheme(vault, "s", "S"));
      const rows = readReplicaLog(origin.vault, { limit: 10_000 }).rows;
      expect(() =>
        applyReplicaLog(seat.vault, rows, { expectedEpoch: "some-other-epoch" })
      ).toThrow(/carries epoch/u);
    } finally {
      origin.close();
      seat.close();
    }
  });

  test("a page never ends in the middle of a commit", () => {
    const origin = openVaultDb();
    try {
      const from = replicaLogState(origin.vault).floor;
      commit(origin, "bulk", (vault) => {
        for (let index = 0; index < 6; index += 1)
          scheme(vault, `s${index}`, `S${index}`);
      });
      commit(origin, "bulk", (vault) => scheme(vault, "later", "Later"));
      const page = readReplicaLog(origin.vault, { since: from, limit: 3 });
      const last = page.rows.at(-1)!;
      const rest = readReplicaLog(origin.vault, {
        since: { epoch: last.epoch, seq: last.seq },
        limit: 10_000,
      });
      // The limit was three; the page carries the whole first commit anyway,
      // and no row of it reappears in the next page.
      expect(page.rows.length).toBeGreaterThan(3);
      expect(rest.rows.every((row) => row.commitSeq !== last.commitSeq)).toBe(
        true
      );
    } finally {
      origin.close();
    }
  });
});
