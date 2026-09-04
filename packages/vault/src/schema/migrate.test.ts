import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { openVaultDb } from "../db.js";
import { AUDIT_BAND_TABLES } from "./audit.js";
import { LEDGER_BAND_TABLES } from "./ledger.js";
import {
  migrate,
  ONTOLOGY_VERSION,
  VAULT_MIGRATIONS,
  VaultSchemaAheadError,
} from "./migrate.js";
import {
  columnNames,
  EDITABLE_DOMAIN_TABLES,
  userVersionOf,
} from "./migrate.test-helpers.js";
import { listVaultEntities, resolveEntity } from "./tables.js";

describe("schema/migrate", () => {
  test("the ontology contract version is the file-and-contract version (ONT-04)", () => {
    // Not a per-row stamp (#916): `core_party` does not carry it, and the one
    // table that does — `agent_command` — is the one the gateway checks for
    // equality.
    expect(ONTOLOGY_VERSION).toBe("1.0");
    const db = openVaultDb();
    expect(columnNames(db.vault, "core_party")).not.toContain(
      "ontology_version"
    );
    expect(columnNames(db.vault, "agent_command")).toContain(
      "ontology_version"
    );
    db.close();
  });

  test("the baseline creates every registered table, and both bands", () => {
    const db = openVaultDb();
    const tables = new Set(
      (
        db.vault
          .prepare(
            `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
          )
          .all() as { name: string }[]
      ).map((r) => r.name)
    );
    for (const logical of listVaultEntities()) {
      const ref = resolveEntity(logical);
      expect(ref, logical).toBeDefined();
      expect(tables.has(ref?.physical ?? ""), logical).toBe(true);
    }
    // ONE FILE (#916): the audit band and the conversation ledger are bands of
    // vault.db, not a sibling database.
    for (const physical of [...AUDIT_BAND_TABLES, ...LEDGER_BAND_TABLES]) {
      expect(tables.has(physical), physical).toBe(true);
    }
    db.close();
  });

  test("editable domain rows expose and maintain updated_at consistently", () => {
    const db = openVaultDb();
    // Every domain table that carries `updated_at`, including the thirteen
    // rung seven gave a trigger to (#883, ruling O-updated) — the tables the
    // ruling names were exactly the ones a member could edit and watch the
    // stamp stand still. `social_contact_card`, `tally_expense_receipt` and the
    // ten home/business tables left the ontology in that same rung.
    for (const table of EDITABLE_DOMAIN_TABLES) {
      const columns = db.vault.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
      }[];
      expect(
        columns.some((column) => column.name === "updated_at"),
        `${table}.updated_at`
      ).toBe(true);
      const trigger = db.vault
        .prepare(
          `SELECT name FROM sqlite_master
          WHERE type = 'trigger' AND tbl_name = ? AND name LIKE '%touch_updated_at'`
        )
        .get(table);
      expect(trigger, `${table} touch trigger`).toBeTruthy();
    }

    const now = new Date().toISOString();
    db.vault
      .prepare(
        `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
       VALUES ('updated-party', 'person', 'Updated', ?, ?)`
      )
      .run(now, now);
    db.vault
      .prepare(
        `INSERT INTO people_profile
         (profile_id, party_id, cadence_days, created_at, updated_at)
       VALUES ('updated-profile', 'updated-party', 30, ?, '2000-01-01T00:00:00.000Z')`
      )
      .run(now);
    db.vault
      .prepare(
        `UPDATE people_profile SET role = 'friend' WHERE profile_id = 'updated-profile'`
      )
      .run();
    const stamp = db.vault
      .prepare(
        `SELECT updated_at FROM people_profile WHERE profile_id = 'updated-profile'`
      )
      .get() as { updated_at: string };
    expect(stamp.updated_at).not.toBe("2000-01-01T00:00:00.000Z");
    db.close();
  });

  test("migrations are idempotent via user_version", () => {
    const db = openVaultDb();
    // openVaultDb already migrated: user_version lands exactly on the top of
    // the ladder.
    const version = db.vault.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(version.user_version).toBe(VAULT_MIGRATIONS.length);

    const before = (
      db.vault
        .prepare(
          `SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name`
        )
        .all() as unknown[]
    ).length;
    expect(() => migrate(db.vault, VAULT_MIGRATIONS)).not.toThrow();
    const afterReplay = db.vault.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(afterReplay.user_version).toBe(VAULT_MIGRATIONS.length);
    const after = (
      db.vault
        .prepare(
          `SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name`
        )
        .all() as unknown[]
    ).length;
    expect(after).toBe(before);
    db.close();
  });

  test("ONE rung: a fresh vault is the baseline and stops at user_version 1", () => {
    expect(VAULT_MIGRATIONS).toHaveLength(1);
    const db = openVaultDb();
    const version = db.vault.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(version.user_version).toBe(1);
    for (const table of [
      "locker_auth_credential",
      "core_entity",
      "core_entity_revision",
      "social_contact_channel",
      "notifications_notice",
      "share_circle_grant",
      "share_authority",
      "share_delivery_config",
      "share_fulfillment",
      "access_provenance",
      "access_receipt",
      "conversations",
    ]) {
      expect(
        db.vault
          .prepare(
            `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`
          )
          .get(table),
        table
      ).toBeTruthy();
    }
    // A baseline states the shape it wants; it does not create a store it then
    // has to drop. Nothing below was ever in a v0 file (#916).
    for (const gone of [
      "people_merge",
      "share_grant",
      "enrich_consent",
      "consent_app",
      "locker_item_history",
      "social_contact_card",
      "tally_expense_receipt",
      "core_observation",
      "agent_correction",
      "agent_judgment",
      "schedule_availability_rule",
      "health_vital",
      "finance_budget",
      "home_asset_item",
      "business_client",
    ]) {
      expect(
        db.vault
          .prepare(
            `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`
          )
          .get(gone),
        gone
      ).toBeUndefined();
    }
    expect(columnNames(db.vault, "access_device")).not.toContain("trust");
    expect(columnNames(db.vault, "media_asset")).not.toContain("favorite");
    expect(columnNames(db.vault, "core_vault")).toContain("self_party_id");
    db.close();
  });

  test("the composed rung includes Locker authentication columns", () => {
    const db = openVaultDb();
    expect(columnNames(db.vault, "locker_auth_credential")).toStrictEqual(
      expect.arrayContaining([
        "credential_id",
        "kind",
        "label",
        "salt",
        "verifier",
        "created_at",
        "updated_at",
      ])
    );
    db.close();
  });

  test("the composed rung includes People profile lifecycle columns", () => {
    const db = openVaultDb();
    expect(columnNames(db.vault, "people_profile")).toStrictEqual(
      expect.arrayContaining(["deleted_at", "purge_at"])
    );
    expect(
      db.vault
        .prepare(
          `SELECT 1 FROM sqlite_master
           WHERE type = 'index' AND name = 'people_profile_purge_idx'`
        )
        .get()
    ).toBeTruthy();
    db.close();
  });

  test("the composed rung includes append-only entity revision storage", () => {
    const db = openVaultDb();
    expect(columnNames(db.vault, "core_entity_revision")).toStrictEqual(
      expect.arrayContaining([
        "revision_id",
        "entity_type",
        "entity_id",
        "operation",
        "snapshot_json",
        "recorded_at",
        "undo_until",
        "undone_at",
      ])
    );
    db.vault
      .prepare(
        `INSERT INTO core_entity_revision
         (revision_id, entity_type, entity_id, operation, snapshot_json, recorded_at, undo_until)
         VALUES ('revision-1', 'core.party', 'party-1', 'update', '{}', ?, ?)`
      )
      .run(new Date().toISOString(), new Date().toISOString());
    const revision = db.vault
      .prepare(
        `SELECT snapshot_json FROM core_entity_revision WHERE revision_id = 'revision-1'`
      )
      .get() as { snapshot_json: string };
    expect(revision.snapshot_json).toBe("{}");
    db.close();
  });

  test("receipt line items hang off the attachment spine, not an app-local table", () => {
    const db = openVaultDb();
    // A receipt is the `role='receipt'` attachment on the expense (#883); typed
    // lines belong to the EXPENSE, and their `receipt_id` names an attachment.
    expect(
      db.vault
        .prepare(
          `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tally_expense_receipt'`
        )
        .get()
    ).toBeUndefined();
    expect(columnNames(db.vault, "tally_expense_line_item")).toStrictEqual(
      expect.arrayContaining([
        "line_item_id",
        "expense_id",
        "receipt_id",
        "kind",
        "amount_minor",
        "sort_order",
      ])
    );
    const foreignKeys = db.vault
      .prepare(`PRAGMA foreign_key_list(tally_expense_line_item)`)
      .all() as { table: string; from: string; on_delete: string }[];
    const receiptFk = foreignKeys.find((fk) => fk.from === "receipt_id");
    expect(receiptFk?.table).toBe("core_attachment");
    // SET NULL, not CASCADE: a by-line division is legal without a photo.
    expect(receiptFk?.on_delete).toBe("SET NULL");
    db.close();
  });

  test("the orphan-grace tombstone table exists on a fresh vault (issue #439 R4)", () => {
    const db = openVaultDb();
    // `blob_orphan` is plumbing, not a registered entity, so the registry sweep
    // above cannot cover it.
    const row = db.vault
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='blob_orphan'`
      )
      .get() as { name: string } | undefined;
    expect(row?.name).toBe("blob_orphan");
    // A valid row round-trips as INTEGER ms.
    db.vault
      .prepare(
        `INSERT INTO blob_orphan (sha256, first_orphaned_at) VALUES (?, ?)`
      )
      .run("a".repeat(64), 1700000000000);
    const stamp = db.vault
      .prepare(`SELECT first_orphaned_at FROM blob_orphan WHERE sha256 = ?`)
      .get("a".repeat(64)) as { first_orphaned_at: number };
    expect(stamp.first_orphaned_at).toBe(1700000000000);
    db.close();
  });

  test("STRICT + CHECK constraints hold: bad enum and negative byte_size rejected", () => {
    const db = openVaultDb();
    expect(() =>
      db.vault
        .prepare(
          `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
         VALUES ('p1', 'alien', 'X', 't', 't')`
        )
        .run()
    ).toThrow(/CHECK/u);
    expect(() =>
      db.vault
        .prepare(
          `INSERT INTO core_content_item (content_id, media_type, content_uri, sha256, byte_size, created_at)
         VALUES ('c1', 'text/plain', 'file:///x', 'abc', -1, 't')`
        )
        .run()
    ).toThrow(/CHECK/u);
    // Floors at 0, not 1 (#821): zero is a storable "never reach out".
    const now = new Date().toISOString();
    db.vault
      .prepare(
        `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
         VALUES ('cad-party', 'person', 'Never', ?, ?)`
      )
      .run(now, now);
    const insertCadence = (profileId: string, days: number): void => {
      db.vault
        .prepare(
          `INSERT INTO people_profile
             (profile_id, party_id, cadence_days, created_at, updated_at)
           VALUES (?, 'cad-party', ?, ?, ?)`
        )
        .run(profileId, days, now, now);
    };
    expect(() => insertCadence("cad-negative", -1)).toThrow(/CHECK/u);
    insertCadence("cad-zero", 0);
    expect(
      (
        db.vault
          .prepare(
            `SELECT cadence_days FROM people_profile WHERE profile_id = 'cad-zero'`
          )
          .get() as { cadence_days: number }
      ).cadence_days
    ).toBe(0);
    db.close();
  });

  test("extend-don't-fork: extension FK uniqueness prevents two extensions of one core row", () => {
    // `health.workout` used to be the example; it left the ontology in rung
    // eight (#916, ruling ONT-06), so R02 is demonstrated on the extension
    // that carries the most traffic instead — a profile decorates exactly one
    // party, and a second one is unrepresentable.
    const db = openVaultDb();
    const now = new Date().toISOString();
    db.vault
      .prepare(
        `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
       VALUES ('p1', 'person', 'Owner', ?, ?)`
      )
      .run(now, now);
    db.vault
      .prepare(
        `INSERT INTO people_profile (profile_id, party_id, cadence_days, created_at, updated_at)
         VALUES ('pf1', 'p1', 30, ?, ?)`
      )
      .run(now, now);
    expect(() =>
      db.vault
        .prepare(
          `INSERT INTO people_profile (profile_id, party_id, cadence_days, created_at, updated_at)
           VALUES ('pf2', 'p1', 30, ?, ?)`
        )
        .run(now, now)
    ).toThrow(/UNIQUE/u);
    db.close();
  });

  // A scratch ladder rather than VAULT_MIGRATIONS: the vault's FTS triggers
  // need `openVaultDb`'s custom SQL function, so a bare handle cannot run the
  // baseline directly, and what is under test is `migrate()` itself.
  const SCRATCH: readonly string[] = [
    "CREATE TABLE scratch_one (x TEXT) STRICT;",
    "CREATE TABLE scratch_two (x TEXT) STRICT;",
  ];

  test("migrate: no-op guard does not fire for a fresh (behind) or already-migrated (equal) db", () => {
    const db = new DatabaseSync(":memory:");
    expect(() => migrate(db, SCRATCH)).not.toThrow();
    const afterFresh = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(afterFresh.user_version).toBe(SCRATCH.length);
    expect(() => migrate(db, SCRATCH)).not.toThrow();
    const afterReplay = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(afterReplay.user_version).toBe(SCRATCH.length);
    db.close();
  });

  test("migrate: user_version ahead of the ladder throws VaultSchemaAheadError with both versions", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, SCRATCH);
    db.exec(`PRAGMA user_version = ${SCRATCH.length + 3}`);
    let caught: unknown;
    try {
      migrate(db, SCRATCH);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(VaultSchemaAheadError);
    const err = caught as VaultSchemaAheadError;
    expect(err.fileVersion).toBe(SCRATCH.length + 3);
    expect(err.knownVersion).toBe(SCRATCH.length);
    expect(err.message).toMatch(/newer version of Centraid/u);
    db.close();
  });

  test("a fresh file on disk reopens with no second rung and no schema drift", () => {
    // ONE BASELINE (#916): "reopen is a no-op" is the whole compatibility
    // story a v0 file has. On a REAL file — the replay above re-runs `migrate`
    // on a handle that never left the process.
    const dir = tempDirSync();
    const first = openVaultDb({ dir });
    const shapeOf = (db: ReturnType<typeof openVaultDb>): string =>
      JSON.stringify(
        db.vault
          .prepare(
            `SELECT type, name, tbl_name, sql FROM sqlite_schema
             WHERE name NOT LIKE 'sqlite_%'
             ORDER BY type, name, tbl_name`
          )
          .all()
      );
    const before = shapeOf(first);
    first.close();

    const vaultFile = path.join(dir, "vault.db");
    expect(userVersionOf(vaultFile)).toBe(1);

    const second = openVaultDb({ dir });
    expect(userVersionOf(vaultFile)).toBe(1);
    expect(shapeOf(second)).toBe(before);
    second.close();
  });

  test("a fresh baseline satisfies its own foreign keys", () => {
    // Thirteen pointer pairs became composite keys (#916) and bootstrap is
    // the first writer to travel them; `foreign_key_check` is the engine's own
    // verdict on every row the baseline leaves behind.
    const db = openVaultDb();
    expect(db.vault.prepare("PRAGMA foreign_key_check").all()).toStrictEqual(
      []
    );
    expect(
      (
        db.vault.prepare("PRAGMA foreign_keys").get() as {
          foreign_keys: number;
        }
      ).foreign_keys
    ).toBe(1);
    db.close();
  });

  test("downgrade guard end-to-end: openVaultDb refuses a file whose schema is ahead, and leaves it untouched", () => {
    const dir = tempDirSync();
    const first = openVaultDb({ dir });
    first.close();

    const vaultFile = path.join(dir, "vault.db");
    const bumped = VAULT_MIGRATIONS.length + 5;
    const raw = new DatabaseSync(vaultFile);
    raw.exec(`PRAGMA user_version = ${bumped}`);
    raw.close();
    expect(userVersionOf(vaultFile)).toBe(bumped);

    expect(() => openVaultDb({ dir })).toThrow(VaultSchemaAheadError);

    // A refused downgrade must leave the artificially bumped file untouched.
    expect(userVersionOf(vaultFile)).toBe(bumped);
  });
});
