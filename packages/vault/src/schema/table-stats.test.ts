import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { dbSizeBreakdown } from "./table-stats.js";

describe("table-stats", () => {
  test("dbstat is available in this repo's node:sqlite build (issue #367 probe)", () => {
    const db = new DatabaseSync(":memory:");
    expect(() =>
      db.prepare("SELECT * FROM dbstat LIMIT 1").all()
    ).not.toThrow();
  });

  test("dbSizeBreakdown reports per-table bytes via dbstat, indexes rolled into their table", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE big(a INTEGER PRIMARY KEY, b TEXT)");
    db.exec("CREATE INDEX idx_big_b ON big(b)");
    db.exec("CREATE TABLE tiny(a INTEGER PRIMARY KEY)");
    const stmt = db.prepare("INSERT INTO big(b) VALUES (?)");
    for (let i = 0; i < 300; i++) stmt.run("x".repeat(200) + i);
    db.exec("INSERT INTO tiny(a) VALUES (1)");

    const breakdown = dbSizeBreakdown(db);

    expect(breakdown.method).toBe("dbstat");
    expect(breakdown.pageCount).toBeGreaterThan(0);
    expect(breakdown.pageSize).toBeGreaterThan(0);
    expect(breakdown.fileBytesTotal).toBe(
      breakdown.pageCount * breakdown.pageSize
    );

    const big = breakdown.tables.find((t) => t.table === "big");
    const tiny = breakdown.tables.find((t) => t.table === "tiny");
    expect(big).toBeDefined();
    expect(tiny).toBeDefined();
    expect(big!.bytes!).toBeGreaterThan(tiny!.bytes!);
    expect(breakdown.tables[0]!.table).toBe("big");
    expect(breakdown.tables.some((t) => t.table === "idx_big_b")).toBe(false);
  });

  test("falls back to a row-count estimate honestly labeled when dbstat is unavailable", () => {
    const real = new DatabaseSync(":memory:");
    real.exec("CREATE TABLE widgets(id INTEGER PRIMARY KEY, name TEXT)");
    real.exec("INSERT INTO widgets(name) VALUES ('a'), ('b'), ('c')");

    const stub = {
      prepare(sql: string) {
        if (sql.includes("FROM dbstat")) {
          return {
            all: () => {
              throw new Error("no such table: dbstat");
            },
          };
        }
        return real.prepare(sql);
      },
    } as unknown as DatabaseSync;

    const breakdown = dbSizeBreakdown(stub);

    expect(breakdown.method).toBe("estimate");
    expect(breakdown.tables).toStrictEqual([{ table: "widgets", rows: 3 }]);
    expect(breakdown.tables[0]!.bytes).toBeUndefined();
  });
});
