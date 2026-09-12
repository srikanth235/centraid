// THE FEED'S VIEW OF THE ONE LOG (#1014, R-1014-1).
//
// These assertions used to be about `replica_change`, a second table filled by
// generated AFTER triggers. The mechanism is gone; the PROPERTIES are the same
// ones the feed's subscribers depend on, so they are stated here against
// `replica_log` instead of deleted with the table.
//
// EVERY WRITE IS BRACKETED. The log is decoded from the session the commit
// bracket opens, so a fixture that writes outside one is not testing the
// mechanism — it is testing what the next commit happens to sweep up. The
// trigger log fired per statement and made that indistinguishable.

import { afterEach, describe, expect, test } from "vitest";

import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { applyExtBand } from "../gateway/ext.js";
import type { ExtTableSpec } from "../schema/ext.js";
import { REPLICA_SCHEMA_EPOCH } from "../schema/replica.js";
import {
  bumpReplicaEpoch,
  currentReplicaLogState,
  initializeReplicaProtocol,
  readReplicaLogPage,
  ReplicaRebootstrapRequiredError,
} from "./change-log.js";
import { formatReplicaCursor, parseReplicaCursor } from "./cursor.js";
import { capturedCommit, insertScheme } from "./replica-log.test-fixtures.js";

let db: VaultDb | undefined;
describe("change-log", () => {
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function open(): VaultDb {
    db = openVaultDb();
    return db;
  }

  /** One captured commit, so each write is its own position in the log. */
  function commit(write: (vault: VaultDb["vault"]) => void): void {
    capturedCommit(db!, "test", write);
  }

  test("canonical inserts, updates and deletes append ordered durable operations", () => {
    const { vault } = open();
    commit(() => insertScheme(vault, "scheme-1", "Before"));
    commit(() =>
      vault
        .prepare(`UPDATE core_concept_scheme SET title = ? WHERE scheme_id = ?`)
        .run("After", "scheme-1")
    );
    commit(() =>
      vault
        .prepare(`DELETE FROM core_concept_scheme WHERE scheme_id = ?`)
        .run("scheme-1")
    );

    const page = readReplicaLogPage(vault);
    // By (entity, row, op) and by ORDER, not by literal seq: one commit's
    // membership trigger writes rows of its own, and what a subscriber
    // depends on is the sequence of operations, not the arithmetic between
    // their positions.
    const scheme = page.changes.filter(
      (change) => change.entity === "core.concept_scheme"
    );
    expect(
      scheme.map(({ entity, rowId, op }) => ({ entity, rowId, op }))
    ).toStrictEqual([
      { entity: "core.concept_scheme", rowId: "scheme-1", op: "insert" },
      { entity: "core.concept_scheme", rowId: "scheme-1", op: "update" },
      { entity: "core.concept_scheme", rowId: "scheme-1", op: "delete" },
    ]);
    const positions = scheme.map((change) => change.seq);
    expect(positions).toStrictEqual([...positions].sort((a, b) => a - b));
    // An insert has no prior state; an update's is `row_json` overlaid with
    // the old values of the columns it changed; a delete's IS `row_json`.
    expect(scheme[0]?.oldValuesJson).toBeNull();
    expect(JSON.parse(scheme[1]!.oldValuesJson!)).toMatchObject({
      scheme_id: "scheme-1",
      title: "Before",
    });
    expect(JSON.parse(scheme[2]!.oldValuesJson!)).toMatchObject({
      scheme_id: "scheme-1",
      title: "After",
    });
    expect(page.next).toStrictEqual(page.watermark);
    expect(page.hasMore).toBe(false);
  });

  /*
   * THE PRIOR IMAGE IS A DELTA PLUS THE IMAGE (#1014, R-1014-13).
   *
   * A session changeset carries the old value of the columns a statement
   * TOUCHED and nothing else, so `prior_json` alone is not a row. Overlaying
   * it on `row_json` is what makes it one, and the columns it does not mention
   * have to come through unchanged — which is the whole reason the delta is
   * sound in the first place.
   */
  test("an update's prior image carries the untouched columns too", () => {
    const { vault } = open();
    commit(() => insertScheme(vault, "scheme-1", "Before"));
    const since = currentReplicaLogState(vault).watermark;
    commit(() =>
      vault
        .prepare(
          `UPDATE core_concept_scheme SET title = 'After' WHERE scheme_id = 'scheme-1'`
        )
        .run()
    );
    const change = readReplicaLogPage(vault, { since }).changes.find(
      (entry) => entry.entity === "core.concept_scheme"
    );
    const prior = JSON.parse(change!.oldValuesJson!) as Record<string, unknown>;
    expect(prior["title"]).toBe("Before");
    // Never written by this statement, and still the row's state before it.
    expect(prior["uri"]).toBe("urn:scheme-1");
    expect(prior["version"]).toBe("1");
  });

  test("OLD snapshots structurally exclude sealed values", () => {
    const { vault } = open();
    const now = new Date().toISOString();
    commit(() =>
      vault
        .prepare(
          `INSERT INTO locker_item
         (item_id, type, title, username, password, compromised, created_at, updated_at)
       VALUES ('secret-item', 'login', 'Before', 'alex', 'never-log-me', 0, ?, ?)`
        )
        .run(now, now)
    );
    const since = currentReplicaLogState(vault).watermark;
    commit(() =>
      vault
        .prepare(
          `UPDATE locker_item SET title = 'After' WHERE item_id = 'secret-item'`
        )
        .run()
    );
    const [change] = readReplicaLogPage(vault, { since }).changes;
    expect(change?.oldValuesJson).not.toContain("never-log-me");
    expect(JSON.parse(change!.oldValuesJson!)).toMatchObject({
      item_id: "secret-item",
      title: "Before",
    });
    expect(JSON.parse(change!.oldValuesJson!)).not.toHaveProperty("password");
  });

  test("OLD snapshots structurally exclude every protocol credential", () => {
    const { vault } = open();
    const now = new Date().toISOString();
    commit(() => {
      vault
        .prepare(
          `INSERT INTO core_party
         (party_id, kind, display_name, created_at, updated_at)
       VALUES ('credential-party', 'agent', 'Credential agent', ?, ?)`
        )
        .run(now, now);
      vault
        .prepare(
          `INSERT INTO access_app
         (app_id, name, display_name, signing_key, status, origin, risk_ceiling, installed_at)
       VALUES ('credential-app', 'credential-app', 'Before app', 'signing-never-log',
               'active', 'installed', 'low', ?)`
        )
        .run(now);
      vault
        .prepare(
          `INSERT INTO access_agent
         (agent_id, party_id, model_ref, version, enrolled_at, status)
       VALUES ('credential-agent', 'credential-party',
               'tier:fast', '1', ?, 'active')`
        )
        .run(now);
      // Key material is a TABLE away since #996 R3, not a column exclusion.
      vault.exec(`INSERT INTO access_agent_secret (agent_id, enrollment_key)
       VALUES ('credential-agent', 'host-never-log')`);
      vault
        .prepare(
          `INSERT INTO access_device
         (device_id, owner_party_id, name, enrolled_at)
       VALUES ('credential-device', 'credential-party', 'Before device', ?)`
        )
        .run(now);
      vault.exec(`INSERT INTO access_device_secret (device_id, public_key)
       VALUES ('credential-device', 'public-never-log')`);
    });
    const since = currentReplicaLogState(vault).watermark;

    commit(() => {
      vault
        .prepare(
          `UPDATE access_app SET display_name = 'After app' WHERE app_id = 'credential-app'`
        )
        .run();
      vault
        .prepare(
          `UPDATE access_agent SET model_ref = 'tier:smart' WHERE agent_id = 'credential-agent'`
        )
        .run();
      vault
        .prepare(
          `UPDATE access_device SET name = 'After device' WHERE device_id = 'credential-device'`
        )
        .run();
    });

    const changes = readReplicaLogPage(vault, { since }).changes;
    // ONE entry per row per commit (#1014, R-1014-1): the write and the touch
    // trigger's own UPDATE bumping `row_version` (#996, R6) are one
    // transaction, so there is exactly one prior image per row to read.
    const old = new Map<string, object>();
    for (const change of changes) {
      if (old.has(change.entity)) continue;
      old.set(
        change.entity,
        JSON.parse(change.oldValuesJson ?? "{}") as object
      );
    }
    expect(old.get("access.app")).toMatchObject({
      display_name: "Before app",
    });
    expect(old.get("access.app")).not.toHaveProperty("signing_key");
    expect(old.get("access.agent")).toMatchObject({ model_ref: "tier:fast" });
    expect(old.get("access.agent")).not.toHaveProperty("enrollment_key");
    expect(old.get("access.device")).toMatchObject({ name: "Before device" });
    expect(old.get("access.device")).not.toHaveProperty("public_key");
    expect(JSON.stringify(changes)).not.toMatch(
      /signing-never-log|host-never-log|public-never-log/u
    );
  });

  test("rolled-back base writes leave no log entry and committed sequence stays monotonic", () => {
    const { vault } = open();
    expect(() =>
      capturedCommit(db!, "test", () => {
        insertScheme(vault, "rolled-back");
        throw new Error("abandon");
      })
    ).toThrow(/abandon/u);
    expect(readReplicaLogPage(vault).changes).toStrictEqual([]);

    commit(() => insertScheme(vault, "committed"));
    const page = readReplicaLogPage(vault);
    expect(page.changes).toHaveLength(1);
    expect(page.changes[0]).toMatchObject({
      seq: 1,
      entity: "core.concept_scheme",
      rowId: "committed",
      op: "insert",
    });
  });

  /*
   * NO TRIGGER PLANE SURVIVES (#1014, R-1014-1).
   *
   * The suite this replaces asserted the OPPOSITE — that every registered
   * canonical table carried three `trg_replica_*` triggers. They are what the
   * ruling retires, `dropReplicaChangeTriggers` removes them from a file that
   * still has them, and nothing installs them again; a re-appearing trigger
   * means a second log has come back.
   */
  test("no replica_change trigger survives, and neither does the table", () => {
    const { vault } = open();
    expect(
      vault
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'trigger' AND name LIKE 'trg\\_replica\\_%' ESCAPE '\\'`
        )
        .all()
    ).toStrictEqual([]);
    expect(
      vault
        .prepare(
          `SELECT 1 AS present FROM sqlite_master
            WHERE type = 'table' AND name = 'replica_change'`
        )
        .get()
    ).toBeUndefined();
  });

  test("live ext rows join the log while draft rows remain scratch-only", () => {
    const extSpec: ExtTableSpec = {
      name: "workout",
      columns: [
        { name: "workout_id", type: "text", primaryKey: true },
        { name: "notes", type: "text" },
      ],
    };
    const opened = open();
    applyExtBand(opened, "gym-log", [extSpec], "live");
    const afterDdl = currentReplicaLogState(opened.vault).watermark;
    commit(() =>
      opened.vault
        .prepare(
          `INSERT INTO ext_gym_log_workout (workout_id, notes) VALUES ('w1', 'run')`
        )
        .run()
    );
    const live = readReplicaLogPage(opened.vault, { since: afterDdl });
    expect(live.changes).toStrictEqual([
      expect.objectContaining({
        entity: "ext.gym-log.workout",
        rowId: "w1",
        op: "insert",
      }),
    ]);

    applyExtBand(opened, "gym-log", [extSpec], "draft");
    const beforeDraftRow = currentReplicaLogState(opened.vault).watermark;
    commit(() =>
      opened.vault
        .prepare(
          `INSERT INTO extdraft_gym_log_workout (workout_id, notes) VALUES ('d1', 'scratch')`
        )
        .run()
    );
    expect(
      readReplicaLogPage(opened.vault, {
        since: beforeDraftRow,
      }).changes.filter((change) => change.entity.startsWith("ext."))
    ).toStrictEqual([]);
  });

  test("cursor pages resume exactly and malformed cursors are refused", () => {
    const { vault } = open();
    commit(() => insertScheme(vault, "a"));
    commit(() => insertScheme(vault, "b"));
    commit(() => insertScheme(vault, "c"));
    // Walk the pages the way a subscriber does — the cursor it sends back is
    // the one the page gave it — and assert the WHOLE span arrives exactly
    // once, in order, with the last page landing on the watermark.
    const seen: string[] = [];
    let cursor = formatReplicaCursor({
      epoch: currentReplicaLogState(vault).epoch,
      seq: 0,
    });
    let page = readReplicaLogPage(vault, { since: cursor, limit: 1 });
    let guard = 0;
    for (;;) {
      for (const change of page.changes) {
        if (change.entity === "core.concept_scheme") seen.push(change.rowId);
      }
      if (!page.hasMore) break;
      expect((guard += 1)).toBeLessThan(50);
      cursor = formatReplicaCursor(page.next);
      expect(parseReplicaCursor(cursor)).toStrictEqual(page.next);
      page = readReplicaLogPage(vault, { since: cursor, limit: 1 });
    }
    expect(seen).toStrictEqual(["a", "b", "c"]);
    expect(page.next).toStrictEqual(page.watermark);
    expect(() => parseReplicaCursor("not-a-cursor")).toThrow(/form/u);
  });

  test("never splits one gateway commit across change pages", () => {
    const { vault } = open();
    commit(() => {
      insertScheme(vault, "commit-a");
      insertScheme(vault, "commit-b");
    });

    const first = readReplicaLogPage(vault, { limit: 1 });
    expect(first.changes).toHaveLength(2);
    expect(new Set(first.changes.map((change) => change.commitId)).size).toBe(
      1
    );
    expect(first.hasMore).toBe(false);
    expect(first.next).toStrictEqual(first.watermark);
  });

  /*
   * A PAGE OF ROWS THE FEED DOES NOT PROJECT STILL ADVANCES (#1014,
   * R-1014-1).
   *
   * The one log carries rows the feed has no entity for — the audit band,
   * which resolves but is deliberately not enumerated (#916), and the
   * gateway-private doorbell lane. If the cursor stalled on them the
   * subscriber would re-read the same span forever.
   */
  test("rows with no projected entity advance the cursor rather than stalling it", () => {
    const { vault } = open();
    commit(() =>
      vault
        .prepare(
          `INSERT INTO access_receipt
             (receipt_id, authority_id, action, object_type, object_id,
              decision, occurred_at, hash)
           VALUES ('r1', NULL, 'act test', 'core.party', 'p1', 'allow', ?, 'h')`
        )
        .run(new Date().toISOString())
    );
    const page = readReplicaLogPage(vault);
    expect(page.changes).toStrictEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.next).toStrictEqual(page.watermark);
    expect(page.watermark.seq).toBeGreaterThan(0);
  });

  test("epoch bump invalidates old cursors and new changes continue above the prior watermark", () => {
    const { vault } = open();
    commit(() => insertScheme(vault, "before"));
    const before = currentReplicaLogState(vault);
    const after = bumpReplicaEpoch(vault, {
      reason: "backup-restore",
      epoch: "11111111-2222-3333-4444-555555555555",
      now: new Date("2026-07-15T00:00:00.000Z"),
    });
    expect(after.epoch).not.toBe(before.epoch);
    expect(after.floor.seq).toBe(before.watermark.seq);
    expect(() =>
      readReplicaLogPage(vault, { since: before.watermark })
    ).toThrow(ReplicaRebootstrapRequiredError);

    commit(() => insertScheme(vault, "after"));
    const page = readReplicaLogPage(vault, { since: after.floor });
    expect(page.changes).toStrictEqual([
      expect.objectContaining({
        epoch: after.epoch,
        rowId: "after",
        seq: before.watermark.seq + 1,
      }),
    ]);
  });

  test("schema epoch skew rotates epoch during protocol initialization", () => {
    const { vault } = open();
    const before = currentReplicaLogState(vault);
    vault
      .prepare(`UPDATE replica_meta SET schema_epoch = 99 WHERE singleton = 1`)
      .run();
    const after = initializeReplicaProtocol(vault);
    expect(after.epoch).not.toBe(before.epoch);
    expect(after.schemaEpoch).toBe(REPLICA_SCHEMA_EPOCH);
    expect(after.epochReason).toBe("schema-change");
  });

  test("warm initialization on a current file rotates nothing", () => {
    const { vault } = open();
    const before = currentReplicaLogState(vault);
    const after = initializeReplicaProtocol(vault);
    expect(after.epoch).toBe(before.epoch);
    expect(after.epochReason).toBe(before.epochReason);
    expect(after.floor).toStrictEqual(before.floor);
  });
});
