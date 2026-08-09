import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { openVaultDb } from "../db.js";
import {
  JOURNAL_MIGRATIONS,
  migrate,
  ONTOLOGY_VERSION,
  VAULT_MIGRATIONS,
  VaultSchemaAheadError,
} from "./migrate.js";
import { listVaultEntities, resolveEntity } from "./tables.js";

function userVersionOf(file: string): number {
  const raw = new DatabaseSync(file);
  const row = raw.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  raw.close();
  return row.user_version;
}

function columnNames(db: DatabaseSync, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((column) => column.name);
}

describe("schema/migrate", () => {
  test("ontology contract version stamps 1.4 (issue #450 canonical consolidation)", () => {
    expect(ONTOLOGY_VERSION).toBe("1.4");
  });

  test("migrations create every table in the registry, in both files", () => {
    const db = openVaultDb();
    const names = (dbFile: typeof db.vault) =>
      new Set(
        (
          dbFile
            .prepare(
              `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
            )
            .all() as {
            name: string;
          }[]
        ).map((r) => r.name)
      );
    const vaultTables = names(db.vault);
    const journalTables = names(db.journal);
    for (const logical of listVaultEntities()) {
      const ref = resolveEntity(logical);
      expect(ref, logical).toBeDefined();
      expect(vaultTables.has(ref?.physical ?? ""), logical).toBe(true);
    }
    for (const logical of [
      "consent.receipt",
      "consent.provenance",
      "agent.command_invocation",
      "agent.evidence",
    ]) {
      const ref = resolveEntity(logical);
      expect(ref?.file).toBe("journal");
      expect(journalTables.has(ref?.physical ?? ""), logical).toBe(true);
    }
    db.close();
  });

  test("editable domain rows expose and maintain updated_at consistently", () => {
    const db = openVaultDb();
    const editableDomainTables = [
      "people_profile",
      "people_important_date",
      "social_contact_card",
      "tally_friend",
      "tally_group",
      "tally_expense",
      "tally_expense_split",
      "tally_expense_receipt",
      "tally_expense_line_item",
      "tally_expense_line_allocation",
      "tally_settlement",
      "tally_obligation",
      "home_asset_item",
      "home_warranty",
      "home_maintenance_plan",
      "home_utility_meter",
      "home_meter_reading",
      "business_client",
      "business_project",
      "business_time_entry",
      "business_invoice",
      "business_invoice_line",
    ] as const;

    for (const table of editableDomainTables) {
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
        `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at, ontology_version)
       VALUES ('updated-party', 'person', 'Updated', ?, ?, ?)`
      )
      .run(now, now, ONTOLOGY_VERSION);
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
    // openVaultDb already migrated; a second migrate run must be a no-op —
    // exercised by reopening the same in-memory handle path being impossible,
    // so assert user_version advanced exactly once per rung.
    const version = db.vault.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(version.user_version).toBe(VAULT_MIGRATIONS.length);
    db.close();
  });

  test("fresh vaults apply the composed base and forward share-attribution rename", () => {
    expect(VAULT_MIGRATIONS).toHaveLength(2);
    const db = openVaultDb();
    const version = db.vault.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(version.user_version).toBe(2);
    for (const table of [
      "locker_auth_credential",
      "core_entity_revision",
      "tally_expense_receipt",
      "social_contact_channel",
      "notifications_notice",
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
    expect(
      db.vault
        .prepare(
          `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'people_merge'`
        )
        .get()
    ).toBeUndefined();
    db.close();
  });

  test("v1 share provenance upgrades shared_by_member without losing rows", () => {
    const dir = tempDirSync();
    const seeded = openVaultDb({ dir });
    seeded.vault.exec(
      `ALTER TABLE core_share_origin RENAME COLUMN shared_by TO shared_by_member;
       PRAGMA user_version = 1;`
    );
    expect(columnNames(seeded.vault, "core_share_origin")).toContain(
      "shared_by_member"
    );
    seeded.vault
      .prepare(
        `INSERT INTO core_share_origin
         (item_type, item_id, origin_vault_id, origin_item_id,
          shared_by_member, shared_at)
       VALUES ('core.collection', 'collection-1', 'vault-origin',
               'collection-origin', 'peer:vault-origin', 42)`
      )
      .run();
    seeded.close();

    const upgraded = openVaultDb({ dir });

    expect(columnNames(upgraded.vault, "core_share_origin")).not.toContain(
      "shared_by_member"
    );
    expect(columnNames(upgraded.vault, "core_share_origin")).toContain(
      "shared_by"
    );
    expect(
      upgraded.vault
        .prepare(
          `SELECT shared_by, shared_at FROM core_share_origin
           WHERE item_type = 'core.collection' AND item_id = 'collection-1'`
        )
        .get()
    ).toMatchObject({ shared_by: "peer:vault-origin", shared_at: 42 });
    upgraded.close();
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

  test("the composed rung includes receipt line-item storage", () => {
    const db = openVaultDb();
    expect(columnNames(db.vault, "tally_expense_receipt")).toStrictEqual(
      expect.arrayContaining([
        "receipt_id",
        "expense_id",
        "content_id",
        "created_at",
        "updated_at",
      ])
    );
    expect(columnNames(db.vault, "tally_expense_line_item")).toStrictEqual(
      expect.arrayContaining([
        "line_item_id",
        "receipt_id",
        "kind",
        "amount_minor",
        "sort_order",
      ])
    );
    db.close();
  });

  test("the orphan-grace tombstone table exists on a fresh vault (issue #439 R4)", () => {
    const db = openVaultDb();
    // `blob_orphan` is plumbing (like blob_replica/blob_access), not a registered
    // logical entity, so the registry sweep above cannot cover it — assert directly.
    const row = db.vault
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='blob_orphan'`
      )
      .get() as { name: string } | undefined;
    expect(row?.name).toBe("blob_orphan");
    // first_orphaned_at must be present; a valid row round-trips as INTEGER ms.
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
          `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at, ontology_version)
         VALUES ('p1', 'alien', 'X', 't', 't', '1.1')`
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
    db.close();
  });

  test("extend-don't-fork: extension FK uniqueness prevents two extensions of one core row", () => {
    const db = openVaultDb();
    const now = new Date().toISOString();
    db.vault
      .prepare(
        `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at, ontology_version)
       VALUES ('p1', 'person', 'Owner', ?, ?, '1.1')`
      )
      .run(now, now);
    db.vault
      .prepare(
        `INSERT INTO core_concept_scheme (scheme_id, uri, title, version) VALUES ('s1', 'urn:x', 'Kinds', '1')`
      )
      .run();
    db.vault
      .prepare(
        `INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label) VALUES ('k1', 's1', 'run', 'Run')`
      )
      .run();
    db.vault
      .prepare(
        `INSERT INTO core_activity (activity_id, actor_party_id, kind_concept_id, started_at, created_at)
       VALUES ('a1', 'p1', 'k1', ?, ?)`
      )
      .run(now, now);
    db.vault
      .prepare(
        `INSERT INTO health_workout (workout_id, activity_id, sport_concept_id) VALUES ('w1', 'a1', 'k1')`
      )
      .run();
    expect(() =>
      db.vault
        .prepare(
          `INSERT INTO health_workout (workout_id, activity_id, sport_concept_id) VALUES ('w2', 'a1', 'k1')`
        )
        .run()
    ).toThrow(/UNIQUE/u);
    db.close();
  });

  // Use JOURNAL_MIGRATIONS: vault FTS needs openVaultDb's custom SQL function,
  // so a bare DatabaseSync cannot run VAULT_MIGRATIONS directly.
  test("migrate: no-op guard does not fire for a fresh (behind) or already-migrated (equal) db", () => {
    const db = new DatabaseSync(":memory:");
    // behind: fresh file, version 0 < migrations.length
    expect(() => migrate(db, JOURNAL_MIGRATIONS)).not.toThrow();
    const afterFresh = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(afterFresh.user_version).toBe(JOURNAL_MIGRATIONS.length);
    // equal: re-running against the now fully-migrated db is a no-op, not a throw
    expect(() => migrate(db, JOURNAL_MIGRATIONS)).not.toThrow();
    const afterReplay = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(afterReplay.user_version).toBe(JOURNAL_MIGRATIONS.length);
    db.close();
  });

  test("migrate: user_version ahead of the ladder throws VaultSchemaAheadError with both versions", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, JOURNAL_MIGRATIONS);
    db.exec(`PRAGMA user_version = ${JOURNAL_MIGRATIONS.length + 3}`);
    let caught: unknown;
    try {
      migrate(db, JOURNAL_MIGRATIONS);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(VaultSchemaAheadError);
    const err = caught as VaultSchemaAheadError;
    expect(err.fileVersion).toBe(JOURNAL_MIGRATIONS.length + 3);
    expect(err.knownVersion).toBe(JOURNAL_MIGRATIONS.length);
    expect(err.message).toMatch(/newer version of Centraid/u);
    db.close();
  });

  test("migrate: the guard also applies to journal.db migrations, not just vault.db", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, JOURNAL_MIGRATIONS);
    db.exec(`PRAGMA user_version = ${JOURNAL_MIGRATIONS.length + 1}`);
    expect(() => migrate(db, JOURNAL_MIGRATIONS)).toThrow(
      VaultSchemaAheadError
    );
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
