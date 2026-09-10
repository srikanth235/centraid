// THE EDGES THE CAPTURE HAS TO SURVIVE (#1014, waves G3/G15/G20/G21).
//
// `log.test.ts` next door holds the three gates the plane exists to pass —
// oracle, convergence, atomicity. These are the cases where the capture's
// ASSUMPTIONS break rather than its decoding: a schema that moves under an
// open session, a commit whose cost the row bound cannot see, and a
// transaction that is undone in the file but not in the session watching it.

import { randomBytes } from "node:crypto";

import { describe, expect, test } from "vitest";

import { openVaultDb } from "../db.js";
import { abandonReplicaCommit, beginReplicaCommit } from "./change-log.js";
import {
  readReplicaLog,
  watchReplicaTable,
  REPLICA_DEFER_THRESHOLD_BYTES,
  REPLICA_PRODUCER_MAX_ROWS,
} from "./log.js";
import { capturedCommit, insertScheme } from "./replica-log.test-fixtures.js";

// WHAT THE SESSION IS NOT WATCHING (#1014, G21) AND WHAT THE DELETE IMAGE IS
// KEYED BY (#1014, G15). Both are the same failure seen twice: the capture
// answers a question about the schema ONCE and the schema moves under it.
describe("a schema that moves under an open capture", () => {
  test("a table planted mid-transaction is watched once it is declared", () => {
    const db = openVaultDb();
    try {
      // An ext band's physical, created the way `applyExtSpecs` creates one.
      const captured = capturedCommit(db, "ext", (vault) => {
        vault.exec(
          `CREATE TABLE "ext_gym_workout" (workout_id TEXT PRIMARY KEY, note TEXT) STRICT`
        );
        watchReplicaTable(vault, "ext_gym_workout");
        vault
          .prepare(`INSERT INTO "ext_gym_workout" VALUES ('w1', 'squats')`)
          .run();
      });
      expect(captured?.tables).toContain("ext_gym_workout");
      const rows = readReplicaLog(db.vault, { limit: 10_000 }).rows.filter(
        (row) => row.table === "ext_gym_workout"
      );
      expect(rows.map((row) => row.op)).toStrictEqual(["insert"]);
      expect(rows[0]!.row?.["note"]).toBe("squats");
    } finally {
      db.close();
    }
  });

  test("a row written into a new physical with nothing watching it is lost", () => {
    // The failure G21 names, stated as a test so the fix above has a floor:
    // WITHOUT the declaration the same commit produces no log row at all.
    const db = openVaultDb();
    try {
      const captured = capturedCommit(db, "ext", (vault) => {
        vault.exec(
          `CREATE TABLE "ext_gym_unwatched" (workout_id TEXT PRIMARY KEY) STRICT`
        );
        vault.prepare(`INSERT INTO "ext_gym_unwatched" VALUES ('w1')`).run();
      });
      expect(captured?.tables ?? []).not.toContain("ext_gym_unwatched");
    } finally {
      db.close();
    }
  });

  test("a delete image keeps its column names after the schema changes", () => {
    const db = openVaultDb();
    try {
      capturedCommit(db, "ext", (vault) => {
        vault.exec(
          `CREATE TABLE "ext_gym_set" (set_id TEXT PRIMARY KEY, reps TEXT, note TEXT) STRICT`
        );
        watchReplicaTable(vault, "ext_gym_set");
        vault
          .prepare(`INSERT INTO "ext_gym_set" VALUES ('s1', '10', 'warm-up')`)
          .run();
        vault
          .prepare(`INSERT INTO "ext_gym_set" VALUES ('s2', '12', 'work set')`)
          .run();
      });
      // A first delete, so the column list is CACHED at the old shape.
      capturedCommit(db, "ext", (vault) => {
        vault.prepare(`DELETE FROM "ext_gym_set" WHERE set_id = 's1'`).run();
      });
      // The DDL an ext alter runs; the cached column list is now wrong, and it
      // is the SOLE source of names for the delete image, which is positional.
      db.vault.exec(`ALTER TABLE "ext_gym_set" DROP COLUMN reps`);
      capturedCommit(db, "ext", (vault) => {
        vault.prepare(`DELETE FROM "ext_gym_set" WHERE set_id = 's2'`).run();
      });
      const deleted = readReplicaLog(db.vault, { limit: 10_000 }).rows.findLast(
        (row) => row.table === "ext_gym_set" && row.op === "delete"
      )!;
      expect(Object.keys(deleted.row ?? {}).sort()).toStrictEqual([
        "note",
        "set_id",
      ]);
      expect(deleted.row?.["note"]).toBe("work set");
    } finally {
      db.close();
    }
  });
});

// THE DEFER THRESHOLD IS IN BYTES, SO IT HAS TO SEE BYTES (#1014, G20).
//
// A commit was measured only when it broke the ROW bound, and the "~38 KB
// gzipped" guarantee behind that bound holds only for rows of ordinary size.
// Fifty rows of embedding BLOBs are tens of megabytes and reported
// `deferred: false` — the one commit a metered seat most needed to skip was
// the one the threshold could not see.
describe("the defer threshold", () => {
  test("measures a small commit of very large rows", () => {
    const db = openVaultDb();
    try {
      const big = randomBytes(64 * 1024).toString("hex");
      const captured = capturedCommit(db, "bulk", (vault) => {
        for (let index = 0; index < 40; index += 1) {
          insertScheme(vault, `big-${index}`, big);
        }
      });
      expect(captured).toBeDefined();
      // Well under the row bound, well over the byte threshold.
      expect(captured!.rows).toBeLessThan(REPLICA_PRODUCER_MAX_ROWS);
      expect(captured!.compressedBytes).toBeGreaterThan(
        REPLICA_DEFER_THRESHOLD_BYTES
      );
      expect(captured!.deferred).toBe(true);
      const rows = readReplicaLog(db.vault, { limit: 10_000 }).rows.filter(
        (row) => row.table === "core_concept_scheme"
      );
      expect(rows.every((row) => row.deferred)).toBe(true);
    } finally {
      db.close();
    }
  });

  test("an ordinary commit is never compressed to find that out", () => {
    const db = openVaultDb();
    try {
      const captured = capturedCommit(db, "seed", (vault) => {
        insertScheme(vault, "small");
      });
      expect(captured!.compressedBytes).toBe(0);
      expect(captured!.deferred).toBe(false);
    } finally {
      db.close();
    }
  });
});

// THE UNDO HAS TO REACH THE CAPTURE (#1014, G3).
//
// A rolled-back transaction's changes are undone in the FILE; the sessions
// watching them are a separate object. `abandonReplicaCommit` was the declared
// contract for closing them and had ZERO production call sites — the rollback
// paths in `gateway.ts` and `execution.ts` simply did not call it — so the
// next `captureReplicaCommit` inherited whatever the abandoned transaction had
// left in them. This is the guard on the call sites now closing that: after a
// rollback the next commit's log carries THAT commit and nothing else.
describe("a rollback and the capture", () => {
  test("abandoning the capture leaves the next commit clean", () => {
    const db = openVaultDb();
    try {
      db.vault.exec("BEGIN");
      beginReplicaCommit(db.vault, { producer: "test" });
      insertScheme(db.vault, "doomed");
      abandonReplicaCommit(db.vault);
      db.vault.exec("ROLLBACK");

      const captured = capturedCommit(db, "test", (vault) => {
        insertScheme(vault, "kept");
      });
      const keys = readReplicaLog(db.vault, { limit: 10_000 }).rows.map((row) =>
        String(row.primaryKey[0] ?? "")
      );
      expect(keys).not.toContain("doomed");
      expect(keys).toContain("kept");
      // The scheme and its `core_entity` row, and nothing the rollback undid.
      expect([...(captured?.tables ?? [])].sort()).toStrictEqual([
        "core_concept_scheme",
        "core_entity",
      ]);
    } finally {
      db.close();
    }
  });
});
