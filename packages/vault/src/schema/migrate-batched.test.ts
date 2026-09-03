import { beforeEach, describe, expect, test } from "vitest";

import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { runBatchedMigration } from "./migrate.js";

const REWRITE = {
  name: "test-backfill",
  selectBatchSql: `SELECT k AS key FROM scratch_rows
                    WHERE k > :cursor ORDER BY k LIMIT :limit`,
  applySql: `UPDATE scratch_rows SET rewrites = rewrites + 1 WHERE k = :key`,
};

let db: VaultDb;

function seedRows(count: number): void {
  db.vault.exec(
    `CREATE TABLE IF NOT EXISTS scratch_rows (
       k TEXT PRIMARY KEY, rewrites INTEGER NOT NULL DEFAULT 0) STRICT`
  );
  const insert = db.vault.prepare(
    "INSERT INTO scratch_rows (k, rewrites) VALUES (?, 0)"
  );
  for (let i = 0; i < count; i += 1)
    insert.run(`row-${i.toString().padStart(4, "0")}`);
}

function rewriteCounts(): number[] {
  return (
    db.vault.prepare("SELECT rewrites FROM scratch_rows ORDER BY k").all() as {
      rewrites: number;
    }[]
  ).map((r) => r.rewrites);
}

describe(runBatchedMigration, () => {
  beforeEach(() => {
    db = openVaultDb();
    seedRows(25);
  });

  test("a call rewrites at most the batches it was given", () => {
    const result = runBatchedMigration(db.vault, REWRITE, {
      batchSize: 10,
      maxBatches: 2,
    });
    expect(result).toStrictEqual({ processed: 20, batches: 2, done: false });
    expect(rewriteCounts().filter((n) => n === 1)).toHaveLength(20);
    expect(rewriteCounts().filter((n) => n === 0)).toHaveLength(5);
  });

  test("a later call resumes from the committed cursor and finishes", () => {
    runBatchedMigration(db.vault, REWRITE, { batchSize: 10, maxBatches: 2 });
    const rest = runBatchedMigration(db.vault, REWRITE, { batchSize: 10 });
    expect(rest.processed).toBe(5);
    expect(rest.done).toBe(true);
    expect(rewriteCounts()).toStrictEqual(Array.from({ length: 25 }, () => 1));
  });

  test("one batch at a time reaches the same end state", () => {
    let calls = 0;
    let done = false;
    while (!done && calls < 100) {
      done = runBatchedMigration(db.vault, REWRITE, {
        batchSize: 4,
        maxBatches: 1,
      }).done;
      calls += 1;
    }
    expect(done).toBe(true);
    expect(calls).toBe(8);
    expect(rewriteCounts()).toStrictEqual(Array.from({ length: 25 }, () => 1));
  });

  test("a completed rewrite is a latch — later calls do no work", () => {
    runBatchedMigration(db.vault, REWRITE, { batchSize: 100 });
    seedRows(0);
    db.vault
      .prepare("INSERT INTO scratch_rows (k, rewrites) VALUES ('row-9999', 0)")
      .run();
    const after = runBatchedMigration(db.vault, REWRITE, { batchSize: 100 });
    expect(after).toStrictEqual({ processed: 0, batches: 0, done: true });
    expect(
      (
        db.vault
          .prepare("SELECT rewrites FROM scratch_rows WHERE k = 'row-9999'")
          .get() as { rewrites: number }
      ).rewrites
    ).toBe(0);
  });

  test("an invalid batch size is refused rather than silently unbounded", () => {
    expect(() =>
      runBatchedMigration(db.vault, REWRITE, { batchSize: 0 })
    ).toThrow(/batch size/u);
    expect(() =>
      runBatchedMigration(db.vault, REWRITE, { maxBatches: 0 })
    ).toThrow(/maxBatches/u);
  });
});
