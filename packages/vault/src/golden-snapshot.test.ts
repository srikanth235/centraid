import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import {
  SNAPSHOT_EXCLUSIONS,
  compareSnapshot,
  primaryKeyOf,
  snapshotTable,
  snapshotVault,
} from "./golden-snapshot.js";

// #892 — THE DEMONSTRATED RED. A golden-vault gate that only ever ran against a
// healthy corpus would pass identically against a `compareSnapshot` that
// returned `{ ok: true }` unconditionally, and nobody would find out until a
// migration ate somebody's notes. Each case below breaks a vault the way a bad
// migration breaks one and requires the comparison to say so, in words.

function seeded(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE note (note_id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT);
    INSERT INTO note VALUES ('a', 'First', 'one');
    INSERT INTO note VALUES ('b', 'Second', 'two');
  `);
  return db;
}

describe("golden-vault snapshot", () => {
  test("a healthy vault compares clean, and says what it compared", () => {
    const db = seeded();
    const frozen = snapshotVault(db);
    const result = compareSnapshot(frozen, db);
    expect(result.ok).toBe(true);
    expect(result.findings).toStrictEqual([]);
    expect(result.compared.rows).toBe(2);
    db.close();
  });

  test("a DROPPED row is data loss and is named", () => {
    const db = seeded();
    const frozen = snapshotVault(db);
    db.exec("DELETE FROM note WHERE note_id = 'b'");
    const result = compareSnapshot(frozen, db);
    expect(result.ok).toBe(false);
    expect(result.findings.join("\n")).toMatch(/GONE after it/u);
    expect(result.findings.join("\n")).toMatch(/\bb\b/u);
    db.close();
  });

  test("a REWRITTEN value is caught even though the row count is unchanged", () => {
    // The failure a row-count check cannot see: a migration that rewrote every
    // member's note body would leave the count identical.
    const db = seeded();
    const frozen = snapshotVault(db);
    db.exec("UPDATE note SET body = 'rewritten' WHERE note_id = 'a'");
    const result = compareSnapshot(frozen, db);
    expect(result.ok).toBe(false);
    expect(result.findings.join("\n")).toMatch(/REWRITTEN by the upgrade/u);
    db.close();
  });

  test("a change of TYPE in place is a change of data", () => {
    // SQLite will hold `1` where `'1'` was. A digest over string values alone
    // would call that identical; the affinity a migration changed is real.
    const db = new DatabaseSync(":memory:");
    db.exec(
      `CREATE TABLE t (id TEXT PRIMARY KEY, n ANY) STRICT; INSERT INTO t VALUES ('a', '1');`
    );
    const frozen = snapshotVault(db);
    db.exec("UPDATE t SET n = 1 WHERE id = 'a'");
    expect(compareSnapshot(frozen, db).ok).toBe(false);
    db.close();
  });

  test("a DROPPED COLUMN is its own class, not a silent pass and not a row error", () => {
    const db = seeded();
    const frozen = snapshotVault(db);
    db.exec("ALTER TABLE note DROP COLUMN body");
    const findings = compareSnapshot(frozen, db).findings.join("\n");
    expect(findings).toMatch(/lost column\(s\) body/u);
    expect(findings).toMatch(/re-freeze the golden corpus/u);
    db.close();
  });

  test("a DROPPED TABLE names how many rows went with it", () => {
    const db = seeded();
    const frozen = snapshotVault(db);
    db.exec("DROP TABLE note");
    expect(compareSnapshot(frozen, db).findings.join("\n")).toMatch(
      /held 2 row\(s\) at freeze time and does not exist/u
    );
    db.close();
  });

  test("ADDED rows and ADDED columns are allowed — a backfill is doing its job", () => {
    const db = seeded();
    const frozen = snapshotVault(db);
    db.exec("ALTER TABLE note ADD COLUMN pinned INTEGER");
    db.exec(
      "INSERT INTO note (note_id, title, body) VALUES ('c', 'Third', 'three')"
    );
    expect(compareSnapshot(frozen, db).ok).toBe(true);
    db.close();
  });

  test("a table with no single-column primary key is counted, never dropped", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(
      `CREATE TABLE pair (a TEXT, b TEXT, PRIMARY KEY (a, b)); INSERT INTO pair VALUES ('x','y');`
    );
    expect(primaryKeyOf(db, "pair")).toBeNull();
    const frozen = snapshotVault(db);
    expect(frozen.pair?.primaryKey).toBeNull();
    expect(frozen.pair?.rows).toBe(1);
    db.exec("DELETE FROM pair");
    expect(compareSnapshot(frozen, db).findings.join("\n")).toMatch(
      /counted only/u
    );
    db.close();
  });

  test("an empty table pins nothing and stays out of the manifest", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE empty (id TEXT PRIMARY KEY);");
    expect(Object.keys(snapshotVault(db))).toStrictEqual([]);
    db.close();
  });

  test("snapshotTable records the frozen column set, sorted", () => {
    const db = seeded();
    expect(snapshotTable(db, "note").columns).toStrictEqual([
      "body",
      "note_id",
      "title",
    ]);
    db.close();
  });

  test("the exclusion list stays short and every entry states a reason", () => {
    // Excluding a table is how this gate would be quietly disarmed one table at a
    // time. The cap is arbitrary; needing to raise it is the signal.
    expect(SNAPSHOT_EXCLUSIONS.size).toBeLessThanOrEqual(3);
    for (const [table, reason] of SNAPSHOT_EXCLUSIONS) {
      expect(
        reason.length,
        `${table} needs a real reason, not a label`
      ).toBeGreaterThan(40);
    }
  });
});
