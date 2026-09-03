import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { bootstrapVault, openVaultDb } from "@centraid/vault";

import { hasSqliteVec, loadSqliteVec } from "./sqlite-vec.js";

describe("sqlite-vec", () => {
  test("a handle opened with the loader can answer vector distance", () => {
    const db = openVaultDb({
      loadExtensions: (handle) => void loadSqliteVec(handle),
    });
    bootstrapVault(db, { ownerName: "Priya" });
    expect(hasSqliteVec(db.vault)).toBe(true);
    const row = db.vault.prepare("SELECT vec_version() AS version").get() as {
      version: string;
    };
    expect(row.version).toMatch(/^v?\d+\.\d+/u);
    db.close();
  });

  test("the SQL door closes behind the load", () => {
    const db = openVaultDb({
      loadExtensions: (handle) => void loadSqliteVec(handle),
    });
    bootstrapVault(db, { ownerName: "Priya" });
    expect(() =>
      db.vault.prepare("SELECT load_extension('/tmp/anything')").get()
    ).toThrow(/not authorized/u);
    db.close();
  });

  test("a vault opened with no loader is simply unmarked, not broken", () => {
    const db = openVaultDb();
    bootstrapVault(db, { ownerName: "Priya" });
    expect(hasSqliteVec(db.vault)).toBe(false);
    expect(
      db.vault.prepare("SELECT count(*) AS n FROM enrich_embedding").get()
    ).toBeDefined();
    db.close();
  });

  test("a handle that never allowed extensions reports unavailable instead of throwing", () => {
    const handle = new DatabaseSync(":memory:");
    const reasons: string[] = [];
    expect(loadSqliteVec(handle, (reason) => reasons.push(reason))).toBe(false);
    expect(reasons).toHaveLength(1);
    expect(hasSqliteVec(handle)).toBe(false);
    handle.close();
  });
});
