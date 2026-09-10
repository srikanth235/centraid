// THE BRACKET IS THE ONLY THING THAT PUTS A WRITE ON A SEAT (#1014).
//
// Every case here asserts the same property from a different angle: after the
// call, the row is in `replica_log`. A writer that mutates a replicated table
// and leaves the log empty is the loss N1/G4/G5/G24 each were.

import { describe, expect, test } from "vitest";

import { openVaultDb } from "../db.js";
import { subscribeReplicaCommits } from "../replica/doorbell.js";
import { readReplicaLog, replicaLogState } from "../replica/log.js";
import {
  bracketReplicaWrites,
  classifyReplicaSql,
  replicaWritesBracketed,
  withReplicaCommit,
} from "./replica-commit.js";

/** Rows this commit put in the log for one table. */
function loggedRows(
  vault: ReturnType<typeof openVaultDb>["vault"],
  table: string
) {
  return readReplicaLog(vault).rows.filter((row) => row.table === table);
}

function insertScheme(
  vault: ReturnType<typeof openVaultDb>["vault"],
  id: string
): void {
  vault
    .prepare(
      `INSERT INTO core_concept_scheme (scheme_id, uri, title, version)
       VALUES (?, ?, ?, '1')`
    )
    .run(id, `urn:${id}`, id);
}

describe("classifying a statement for the bracket", () => {
  test("names the statements the bracket has to react to", () => {
    expect(classifyReplicaSql("  INSERT INTO t VALUES (1)")).toBe("mutating");
    expect(classifyReplicaSql("-- a note\nUPDATE t SET a = 1")).toBe(
      "mutating"
    );
    expect(classifyReplicaSql("/* c */ DELETE FROM t")).toBe("mutating");
    expect(classifyReplicaSql("WITH x AS (SELECT 1) DELETE FROM t")).toBe(
      "mutating"
    );
    expect(classifyReplicaSql("WITH x AS (SELECT 1) SELECT * FROM x")).toBe(
      "other"
    );
    expect(classifyReplicaSql("BEGIN IMMEDIATE")).toBe("begin");
    expect(classifyReplicaSql("COMMIT")).toBe("commit");
    expect(classifyReplicaSql("ROLLBACK")).toBe("rollback");
    expect(classifyReplicaSql("ROLLBACK TO sweep_row")).toBe("rollback-to");
    expect(classifyReplicaSql("SAVEPOINT sweep_row")).toBe("savepoint");
    expect(classifyReplicaSql("RELEASE sweep_row")).toBe("release");
    expect(classifyReplicaSql("SELECT 1")).toBe("other");
  });
});

describe("one bracketed replica commit", () => {
  test("a write inside it is in the log; the doorbell rings after COMMIT", () => {
    const db = openVaultDb();
    try {
      let rangWhileOpen: boolean | undefined;
      const stop = subscribeReplicaCommits(db.vault, () => {
        rangWhileOpen = db.vault.isTransaction;
      });
      withReplicaCommit(db.vault, () => insertScheme(db.vault, "bracketed"));
      stop();
      expect(loggedRows(db.vault, "core_concept_scheme")).toHaveLength(1);
      expect(rangWhileOpen).toBe(false);
    } finally {
      db.vault.close();
    }
  });

  test("a throw rolls back and leaves the watermark where it was", () => {
    const db = openVaultDb();
    try {
      const before = replicaLogState(db.vault).watermark.seq;
      expect(() =>
        withReplicaCommit(db.vault, () => {
          insertScheme(db.vault, "lost");
          throw new Error("writer failed");
        })
      ).toThrow("writer failed");
      expect(db.vault.isTransaction).toBe(false);
      expect(replicaLogState(db.vault).watermark.seq).toBe(before);
      // The abandoned session must not resurface in the NEXT commit.
      withReplicaCommit(db.vault, () => insertScheme(db.vault, "kept"));
      const rows = loggedRows(db.vault, "core_concept_scheme");
      expect(rows.map((row) => row.primaryKey[0])).toStrictEqual(["kept"]);
    } finally {
      db.vault.close();
    }
  });

  test("nested inside a caller's transaction, the outer pair still owns it", () => {
    const db = openVaultDb();
    try {
      withReplicaCommit(db.vault, () => {
        expect(db.vault.isTransaction).toBe(true);
        withReplicaCommit(db.vault, () => insertScheme(db.vault, "inner"));
        insertScheme(db.vault, "outer");
      });
      const rows = loggedRows(db.vault, "core_concept_scheme");
      expect(rows.map((row) => row.primaryKey[0]).sort()).toStrictEqual([
        "inner",
        "outer",
      ]);
      // ONE commit, not two: the inner call neither committed nor decoded.
      expect(new Set(rows.map((row) => row.seq)).size).toBe(2);
    } finally {
      db.vault.close();
    }
  });
});

describe("bracketReplicaWrites (a by-path connection brackets its own writes)", () => {
  test("a bare statement outside a transaction lands in the log", () => {
    const db = openVaultDb();
    try {
      bracketReplicaWrites(db.vault, { producer: "worker" });
      expect(replicaWritesBracketed(db.vault)).toBe(true);
      insertScheme(db.vault, "worker-row");
      const rows = loggedRows(db.vault, "core_concept_scheme");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.producer).toBe("worker");
      expect(db.vault.isTransaction).toBe(false);
    } finally {
      db.vault.close();
    }
  });

  test("a caller's own BEGIN/COMMIT block is one commit", () => {
    const db = openVaultDb();
    try {
      bracketReplicaWrites(db.vault, { producer: "worker" });
      db.vault.exec("BEGIN IMMEDIATE");
      insertScheme(db.vault, "a");
      insertScheme(db.vault, "b");
      db.vault.exec("COMMIT");
      const rows = loggedRows(db.vault, "core_concept_scheme");
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.commitSeq)).size).toBe(1);
    } finally {
      db.vault.close();
    }
  });

  test("an outermost SAVEPOINT/RELEASE block is one commit", () => {
    const db = openVaultDb();
    try {
      bracketReplicaWrites(db.vault, { producer: "worker" });
      db.vault.prepare("SAVEPOINT s").run();
      insertScheme(db.vault, "sp");
      db.vault.prepare("RELEASE s").run();
      expect(db.vault.isTransaction).toBe(false);
      expect(loggedRows(db.vault, "core_concept_scheme")).toHaveLength(1);
    } finally {
      db.vault.close();
    }
  });

  test("a rolled-back block logs nothing and does not poison the next one", () => {
    const db = openVaultDb();
    try {
      bracketReplicaWrites(db.vault, { producer: "worker" });
      db.vault.exec("BEGIN IMMEDIATE");
      insertScheme(db.vault, "gone");
      db.vault.exec("ROLLBACK");
      insertScheme(db.vault, "here");
      const rows = loggedRows(db.vault, "core_concept_scheme");
      expect(rows.map((row) => row.primaryKey[0])).toStrictEqual(["here"]);
    } finally {
      db.vault.close();
    }
  });

  test("the doorbell rings on this connection's handle after each commit", () => {
    const db = openVaultDb();
    try {
      bracketReplicaWrites(db.vault, { producer: "worker" });
      let rings = 0;
      const stop = subscribeReplicaCommits(db.vault, () => {
        rings += 1;
      });
      insertScheme(db.vault, "ring");
      stop();
      expect(rings).toBeGreaterThan(0);
    } finally {
      db.vault.close();
    }
  });

  test("a savepoint rollback keeps the pair and drops only the undone row", () => {
    const db = openVaultDb();
    try {
      bracketReplicaWrites(db.vault, { producer: "worker" });
      db.vault.exec("BEGIN IMMEDIATE");
      insertScheme(db.vault, "kept");
      db.vault.exec("SAVEPOINT sp");
      insertScheme(db.vault, "undone");
      db.vault.exec("ROLLBACK TO sp");
      db.vault.exec("RELEASE sp");
      db.vault.exec("COMMIT");
      const rows = loggedRows(db.vault, "core_concept_scheme");
      expect(rows.map((row) => row.primaryKey[0])).toStrictEqual(["kept"]);
    } finally {
      db.vault.close();
    }
  });

  test("it is idempotent per connection", () => {
    const db = openVaultDb();
    try {
      const once = bracketReplicaWrites(db.vault);
      const twice = bracketReplicaWrites(db.vault);
      expect(once).toBe(twice);
      insertScheme(db.vault, "once");
      expect(loggedRows(db.vault, "core_concept_scheme")).toHaveLength(1);
    } finally {
      db.vault.close();
    }
  });
});
