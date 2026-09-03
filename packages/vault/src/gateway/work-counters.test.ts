import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { diffCounters, WORK_COUNTER_KEYS } from "@centraid/core/protocol";

import {
  bumpWorkCounter,
  gatewayWorkCounters,
  instrumentVaultStatements,
} from "./work-counters.js";

function counted(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  instrumentVaultStatements(db);
  return db;
}

describe("gateway work counters", () => {
  it("counts one statement per execution, not per prepare", () => {
    const db = counted();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
    const before = gatewayWorkCounters();
    const insert = db.prepare("INSERT INTO t (id, name) VALUES (?, ?)");
    expect(diffCounters(before, gatewayWorkCounters()).statements).toBe(0);
    insert.run(1, "a");
    insert.run(2, "b");
    expect(diffCounters(before, gatewayWorkCounters()).statements).toBe(2);
    db.close();
  });

  it("counts rows and payload bytes read, per row shape", () => {
    const db = counted();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
    db.prepare("INSERT INTO t (id, name) VALUES (?, ?)").run(1, "abcde");
    const before = gatewayWorkCounters();
    const rows = db.prepare("SELECT id, name FROM t").all();
    const delta = diffCounters(before, gatewayWorkCounters());
    expect(rows).toHaveLength(1);
    expect(delta.rowsScanned).toBe(1);
    // 8 for the integer id, 5 UTF-16 units for "abcde".
    expect(delta.bytesRead).toBe(13);
    db.close();
  });

  it("a wider SELECT costs more bytes — the regression the gate must see", () => {
    const db = counted();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, blobby TEXT)");
    db.prepare("INSERT INTO t VALUES (?, ?, ?)").run(1, "ab", "cdefghij");
    const beforeNarrow = gatewayWorkCounters();
    db.prepare("SELECT id FROM t").all();
    const narrow = diffCounters(beforeNarrow, gatewayWorkCounters());
    const beforeWide = gatewayWorkCounters();
    db.prepare("SELECT * FROM t").all();
    const wide = diffCounters(beforeWide, gatewayWorkCounters());
    expect(wide.bytesRead).toBeGreaterThan(narrow.bytesRead);
    expect(wide.rowsScanned).toBe(narrow.rowsScanned);
    db.close();
  });

  it("counts bound parameter bytes as bytes written", () => {
    const db = counted();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
    const before = gatewayWorkCounters();
    db.prepare("INSERT INTO t (id, name) VALUES (?, ?)").run(1, "abcd");
    const delta = diffCounters(before, gatewayWorkCounters());
    expect(delta.bytesWritten).toBe(12);
    db.close();
  });

  it("counts a durability barrier — COMMIT and a WAL checkpoint — as an fsync", () => {
    const db = counted();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const before = gatewayWorkCounters();
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO t (id) VALUES (?)").run(1);
    db.exec("COMMIT");
    const delta = diffCounters(before, gatewayWorkCounters());
    expect(delta.fsyncs).toBe(1);
    // Statements: BEGIN, the INSERT, COMMIT.
    expect(delta.statements).toBe(3);
    db.close();
  });

  it("a seeded extra statement on a hot path moves an integer", () => {
    const db = counted();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const read = (extra: boolean): number => {
      const before = gatewayWorkCounters();
      db.prepare("SELECT id FROM t").all();
      if (extra) db.prepare("SELECT count(*) AS n FROM t").get();
      return diffCounters(before, gatewayWorkCounters()).statements;
    };
    expect(read(false)).toBe(1);
    expect(read(true)).toBe(2);
    db.close();
  });

  it("instrumenting the same handle twice does not double-count", () => {
    const db = counted();
    instrumentVaultStatements(db);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const before = gatewayWorkCounters();
    db.prepare("SELECT id FROM t").all();
    expect(diffCounters(before, gatewayWorkCounters()).statements).toBe(1);
    db.close();
  });

  it("totals are monotonic, so any two snapshots diff without throwing", () => {
    const before = gatewayWorkCounters();
    bumpWorkCounter("invalidations", 3);
    bumpWorkCounter("invalidations", 0);
    bumpWorkCounter("invalidations", -5);
    const delta = diffCounters(before, gatewayWorkCounters());
    expect(delta.invalidations).toBe(3);
    for (const key of WORK_COUNTER_KEYS) {
      expect(Number.isSafeInteger(delta[key])).toBe(true);
      expect(delta[key]).toBeGreaterThanOrEqual(0);
    }
  });

  it("keeps the statement surface usable: columns and iterate still work", () => {
    const db = counted();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
    db.prepare("INSERT INTO t VALUES (?, ?)").run(1, "a");
    const statement = db.prepare("SELECT id, name FROM t");
    expect(statement.columns().map((column) => column.name)).toStrictEqual([
      "id",
      "name",
    ]);
    expect(statement.sourceSQL).toContain("SELECT");
    expect([...statement.iterate()]).toHaveLength(1);
    db.close();
  });
});
