import { afterEach, describe, expect, test } from "vitest";

import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { readReplicaChanges } from "./change-log.js";
import {
  readReplicaRow,
  readReplicaRows,
  withReplicaSnapshot,
} from "./snapshot.js";

let db: VaultDb | undefined;
describe("snapshot", () => {
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  test("replica row helpers structurally exclude sealed columns and defer large values", () => {
    db = openVaultDb();
    db.vault
      .prepare(
        `INSERT INTO locker_item (
         item_id, type, title, password, notes, created_at, updated_at
       ) VALUES ('login-1', 'login', 'Bank', 'ciphertext-must-never-leave',
                 'this note is deliberately oversized', 't', 't')`
      )
      .run();

    const page = readReplicaRows(db.vault, "locker.item", { maxValueBytes: 8 });
    expect(page.sealedColumns).toContain("password");
    expect(page.columns).not.toContain("password");
    expect(page.rows).toStrictEqual([
      expect.objectContaining({
        rowId: "login-1",
        values: expect.objectContaining({ item_id: "login-1", title: "Bank" }),
        deferredColumns: expect.arrayContaining(["notes"]),
      }),
    ]);
    expect(page.rows[0]?.values).not.toHaveProperty("password");
    expect(page.rows[0]?.deferredColumns).not.toContain("password");
  });

  test("unmasked snapshot and lazy reads structurally exclude protocol credentials", () => {
    db = openVaultDb();
    db.vault
      .prepare(
        `INSERT INTO access_app
         (app_id, name, display_name, signing_key, status, origin, risk_ceiling, installed_at)
       VALUES ('credential-app', 'credential-app', 'Credential app', 'signing-never-replicate',
               'active', 'installed', 'low', '2026-07-15T00:00:00.000Z')`
      )
      .run();

    const snapshot = readReplicaRows(db.vault, "access.app");
    expect(snapshot.columns).not.toContain("signing_key");
    expect(snapshot.rows).toStrictEqual([
      expect.objectContaining({
        rowId: "credential-app",
        values: expect.objectContaining({
          app_id: "credential-app",
          name: "credential-app",
        }),
      }),
    ]);
    expect(snapshot.rows[0]?.values).not.toHaveProperty("signing_key");
    expect(snapshot.rows[0]?.deferredColumns).not.toContain("signing_key");

    const lazy = readReplicaRow(db.vault, "access.app", "credential-app");
    expect(lazy?.values).not.toHaveProperty("signing_key");
    expect(lazy?.deferredColumns).not.toContain("signing_key");
    expect(JSON.stringify({ snapshot, lazy })).not.toContain(
      "signing-never-replicate"
    );
  });

  test("changed rows can be fetched by log row id and deletes resolve absent", () => {
    db = openVaultDb();
    db.vault
      .prepare(
        `INSERT INTO core_concept_scheme (scheme_id, uri, title, version)
       VALUES ('scheme-1', 'urn:scheme-1', 'Kinds', '1')`
      )
      .run();
    const change = readReplicaChanges(db.vault).changes[0];
    expect(change?.rowId).toBe("scheme-1");
    expect(
      readReplicaRow(db.vault, change?.entity ?? "", change?.rowId ?? "")
    ).toMatchObject({
      rowId: "scheme-1",
      values: expect.objectContaining({ title: "Kinds" }),
    });

    db.vault
      .prepare(`DELETE FROM core_concept_scheme WHERE scheme_id = 'scheme-1'`)
      .run();
    expect(
      readReplicaRow(db.vault, "core.concept_scheme", "scheme-1")
    ).toBeUndefined();
  });

  test("attaches the current canonical row version to snapshot rows", () => {
    db = openVaultDb();
    db.vault
      .prepare(
        `INSERT INTO core_concept_scheme (scheme_id, uri, title, version)
       VALUES ('scheme-versioned', 'urn:scheme-versioned', 'Before', '1')`
      )
      .run();
    db.vault
      .prepare(
        `UPDATE core_concept_scheme SET title = 'After'
          WHERE scheme_id = 'scheme-versioned'`
      )
      .run();

    const row = readReplicaRows(db.vault, "core.concept_scheme").rows[0];
    expect(row).toMatchObject({ rowId: "scheme-versioned", rowVersion: 2 });
    expect(
      readReplicaRow(db.vault, "core.concept_scheme", "scheme-versioned")
    ).toMatchObject({ rowId: "scheme-versioned", rowVersion: 2 });
  });

  /*
   * THE VERSION IS THE ROW'S COLUMN, NOT THE LOG'S POSITION (#996, R6).
   *
   * Red-first: with unrelated commits ahead of it, `MAX(seq)` over
   * `replica_change` and `row_version` are different numbers, and the old
   * answer was the log's. A seat stored that as its row's version and sent it
   * back as an intent's base version, while the gateway's conflict check read
   * `row_version` — so every offline edit of a row the projector had touched
   * came back conflicted, comparing a log seq against a row version.
   */
  test("a row's version is its own column, not its position in the log", () => {
    db = openVaultDb();
    const owner = "party-owner";
    db.vault
      .prepare(
        "INSERT INTO core_entity (entity_id, entity_type, created_at) VALUES (?, 'core.party', 't')"
      )
      .run(owner);
    db.vault
      .prepare(
        `INSERT INTO core_party (party_id, kind, display_name, created_at)
         VALUES (?, 'person', 'Owner', 't')`
      )
      .run(owner);
    const task = (id: string): void => {
      db!.vault
        .prepare(
          "INSERT INTO core_entity (entity_id, entity_type, created_at) VALUES (?, 'schedule.task', 't')"
        )
        .run(id);
      db!.vault
        .prepare(
          `INSERT INTO schedule_task (task_id, owner_party_id, title, status, priority)
           VALUES (?, ?, 'Once', 'needs-action', 5)`
        )
        .run(id, owner);
    };
    // Traffic FIRST, so the log is well past 1 before this row exists.
    for (let n = 0; n < 5; n++) task(`task-noise-${n}`);
    task("task-late");

    const logSeq = (
      db.vault
        .prepare(
          `SELECT MAX(seq) AS seq FROM replica_change
            WHERE entity = 'schedule.task' AND row_id = 'task-late'`
        )
        .get() as { seq: number }
    ).seq;
    // The two really do disagree here, or this test proves nothing.
    expect(logSeq).toBeGreaterThan(1);

    expect(
      readReplicaRow(db.vault, "schedule.task", "task-late")
    ).toMatchObject({ rowVersion: 1 });
    expect(
      readReplicaRows(db.vault, "schedule.task").rows.find(
        (row) => row.rowId === "task-late"
      )
    ).toMatchObject({ rowVersion: 1 });
  });

  test("snapshot reader returns rows pinned to the same reported watermark", () => {
    db = openVaultDb();
    db.vault
      .prepare(
        `INSERT INTO core_concept_scheme (scheme_id, uri, title, version)
       VALUES ('scheme-1', 'urn:scheme-1', 'Kinds', '1')`
      )
      .run();
    const snapshot = withReplicaSnapshot(db.vault, (reader) =>
      reader.readRows("core.concept_scheme")
    );
    expect(snapshot.state.watermark.seq).toBe(1);
    expect(snapshot.value.rows.map((row) => row.rowId)).toStrictEqual([
      "scheme-1",
    ]);
  });

  test("protocol intent rows are not exposed by the generic ontology snapshot helper", () => {
    db = openVaultDb();
    const vault = db.vault;
    expect(() => readReplicaRows(vault, "replica.intent")).toThrow(
      /unknown replica entity/u
    );
  });
});
