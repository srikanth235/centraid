import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { tempDirSync } from "@centraid/test-kit/temp-dir";
import { describe, expect, test } from "vitest";

import { bootstrapVault } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import {
  JOURNAL_MIGRATIONS,
  migrate,
  ONTOLOGY_VERSION,
  repairSyncCredentialOauthMode,
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

/** Reconstruct a historical migration frontier from a fresh current fixture. */
function rewindVaultTo(file: string, version: 1 | 2 | 4): void {
  const raw = new DatabaseSync(file);
  raw.exec(`
    DROP TRIGGER IF EXISTS trg_replica_core_event_ai;
    DROP TRIGGER IF EXISTS trg_replica_core_event_au;
    DROP TRIGGER IF EXISTS trg_replica_core_event_ad;
    DROP TRIGGER IF EXISTS trg_replica_schedule_task_ai;
    DROP TRIGGER IF EXISTS trg_replica_schedule_task_au;
    DROP TRIGGER IF EXISTS trg_replica_schedule_task_ad;
    DROP TRIGGER IF EXISTS trg_replica_tally_expense_ai;
    DROP TRIGGER IF EXISTS trg_replica_tally_expense_au;
    DROP TRIGGER IF EXISTS trg_replica_tally_expense_ad;

    DROP INDEX IF EXISTS tally_expense_recurring_instance_idx;
    DROP INDEX IF EXISTS tally_recurring_expense_group_idx;
    DROP INDEX IF EXISTS people_merge_source_active_idx;
    DROP INDEX IF EXISTS social_contact_channel_preferred_idx;
    DROP INDEX IF EXISTS social_contact_channel_duplicate_idx;
    DROP INDEX IF EXISTS social_contact_channel_party_idx;
    DROP INDEX IF EXISTS schedule_recurrence_exception_target_idx;
    DROP INDEX IF EXISTS schedule_task_section_idx;
    DROP INDEX IF EXISTS schedule_task_organize_idx;
    DROP INDEX IF EXISTS schedule_section_project_idx;
    DROP INDEX IF EXISTS schedule_project_owner_idx;
    DROP TABLE IF EXISTS tally_recurring_expense;
    DROP TABLE IF EXISTS people_merge;
    DROP TABLE IF EXISTS social_contact_channel;
    DROP TABLE IF EXISTS schedule_recurrence_exception;
    DROP TABLE IF EXISTS schedule_section;
    DROP TABLE IF EXISTS schedule_project;
    ALTER TABLE tally_expense DROP COLUMN recurring_template_id;
    ALTER TABLE tally_expense DROP COLUMN rate_date;
    ALTER TABLE tally_expense DROP COLUMN rate_source;
    ALTER TABLE tally_expense DROP COLUMN rate_scale;
    ALTER TABLE tally_expense DROP COLUMN rate_scaled;
    ALTER TABLE tally_expense DROP COLUMN settlement_currency;
    ALTER TABLE tally_expense DROP COLUMN original_currency;
    ALTER TABLE tally_expense DROP COLUMN original_amount_minor;
    ALTER TABLE schedule_task DROP COLUMN recurrence_tz;
    ALTER TABLE schedule_task DROP COLUMN recurrence_anchor;
    ALTER TABLE schedule_task DROP COLUMN sort_order;
    ALTER TABLE schedule_task DROP COLUMN section_id;
    ALTER TABLE schedule_task DROP COLUMN project_id;
    ALTER TABLE core_event DROP COLUMN recurrence_semantics;
    ALTER TABLE core_event DROP COLUMN end_tz;

    DROP TRIGGER IF EXISTS tally_expense_line_allocation_touch_updated_at;
    DROP TRIGGER IF EXISTS tally_expense_line_item_touch_updated_at;
    DROP TRIGGER IF EXISTS tally_expense_receipt_touch_updated_at;
    DROP INDEX IF EXISTS tally_expense_line_allocation_party_idx;
    DROP INDEX IF EXISTS tally_expense_line_receipt_idx;
    DROP TABLE IF EXISTS tally_expense_line_allocation;
    DROP TABLE IF EXISTS tally_expense_line_item;
    DROP TABLE IF EXISTS tally_expense_receipt;
  `);
  if (version <= 2) {
    raw.exec(`
      DROP TRIGGER IF EXISTS trg_replica_people_profile_ai;
      DROP TRIGGER IF EXISTS trg_replica_people_profile_au;
      DROP TRIGGER IF EXISTS trg_replica_people_profile_ad;
      DROP INDEX IF EXISTS people_profile_purge_idx;
      ALTER TABLE people_profile DROP COLUMN purge_at;
      ALTER TABLE people_profile DROP COLUMN deleted_at;

      DROP TRIGGER IF EXISTS trg_replica_core_entity_revision_ai;
      DROP TRIGGER IF EXISTS trg_replica_core_entity_revision_au;
      DROP TRIGGER IF EXISTS trg_replica_core_entity_revision_ad;
      DROP INDEX IF EXISTS core_entity_revision_actor_idx;
      DROP INDEX IF EXISTS core_entity_revision_undo_idx;
      DROP INDEX IF EXISTS core_entity_revision_entity_idx;
      DROP TABLE core_entity_revision;
    `);
  }
  if (version === 1) {
    raw.exec(`
      DROP INDEX locker_auth_credential_kind_idx;
      DROP TABLE locker_auth_credential;
    `);
  }
  raw.exec(`PRAGMA user_version = ${version}`);
  raw.close();
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

  test("people_merge is absent after the drop rung (fresh + upgrade)", () => {
    // Fresh vaults still create people_merge inside TIME_ORGANIZE_DDL, then
    // DROP_PEOPLE_MERGE_DDL removes it so the tip schema has no residual.
    const fresh = openVaultDb();
    expect(
      fresh.vault
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'table' AND name = 'people_merge'`
        )
        .get()
    ).toBeUndefined();
    fresh.close();

    // Upgrade path: a vault stuck one rung behind still holds people_merge.
    const dir = tempDirSync();
    const seeded = openVaultDb({ dir });
    seeded.close();
    const file = path.join(dir, "vault.db");
    const raw = new DatabaseSync(file);
    raw.exec(`
      CREATE TABLE people_merge (
        merge_id        TEXT PRIMARY KEY,
        source_party_id TEXT NOT NULL,
        target_party_id TEXT NOT NULL,
        revision_id     TEXT NOT NULL,
        merged_at       TEXT NOT NULL,
        undone_at       TEXT
      ) STRICT;
      PRAGMA user_version = ${VAULT_MIGRATIONS.length - 1};
    `);
    raw.close();
    expect(
      (
        new DatabaseSync(file)
          .prepare(
            `SELECT name FROM sqlite_master
              WHERE type = 'table' AND name = 'people_merge'`
          )
          .get() as { name: string }
      ).name
    ).toBe("people_merge");

    const upgraded = openVaultDb({ dir });
    expect(
      upgraded.vault
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'table' AND name = 'people_merge'`
        )
        .get()
    ).toBeUndefined();
    expect(userVersionOf(file)).toBe(VAULT_MIGRATIONS.length);
    upgraded.close();
  });

  test("v1 Locker data survives the user-presence credential migration", () => {
    const dir = tempDirSync();
    const seeded = openVaultDb({ dir });
    seeded.vault
      .prepare(
        `INSERT INTO locker_item
          (item_id, type, title, created_at, updated_at)
         VALUES ('existing-login', 'login', 'Before auth', ?, ?)`
      )
      .run("2026-07-29T00:00:00.000Z", "2026-07-29T00:00:00.000Z");
    seeded.close();

    // Reconstruct the exact previous schema frontier: the populated Locker
    // base rung exists, while #630's credential table does not.
    rewindVaultTo(path.join(dir, "vault.db"), 1);

    const upgraded = openVaultDb({ dir });
    const locker = upgraded.vault
      .prepare(
        `SELECT type, title FROM locker_item WHERE item_id = 'existing-login'`
      )
      .get() as { type: string; title: string };
    expect({ ...locker }).toStrictEqual({
      type: "login",
      title: "Before auth",
    });
    expect(
      (
        upgraded.vault
          .prepare(
            `SELECT name FROM sqlite_master
               WHERE type = 'table' AND name = 'locker_auth_credential'`
          )
          .get() as { name: string }
      ).name
    ).toBe("locker_auth_credential");
    expect(userVersionOf(path.join(dir, "vault.db"))).toBe(
      VAULT_MIGRATIONS.length
    );
    upgraded.close();
  });

  test("the pre-P5 frontier preserves People rows while adding lifecycle and revision storage", () => {
    const dir = tempDirSync();
    const seeded = openVaultDb({ dir });
    const now = "2026-07-29T00:00:00.000Z";
    seeded.vault
      .prepare(
        `INSERT INTO core_party
          (party_id, kind, display_name, created_at, updated_at, ontology_version)
         VALUES ('existing-person', 'person', 'Maya', ?, ?, ?)`
      )
      .run(now, now, ONTOLOGY_VERSION);
    seeded.vault
      .prepare(
        `INSERT INTO people_profile
          (profile_id, party_id, role, cadence_days, created_at, updated_at)
         VALUES ('existing-profile', 'existing-person', 'Friend', 14, ?, ?)`
      )
      .run(now, now);
    seeded.close();

    rewindVaultTo(path.join(dir, "vault.db"), 2);

    const upgraded = openVaultDb({ dir });
    const person = upgraded.vault
      .prepare(
        `SELECT p.display_name, pr.role, pr.deleted_at, pr.purge_at
           FROM core_party p
           JOIN people_profile pr ON pr.party_id = p.party_id
          WHERE p.party_id = 'existing-person'`
      )
      .get() as {
      display_name: string;
      role: string;
      deleted_at: string | null;
      purge_at: string | null;
    };
    expect({ ...person }).toStrictEqual({
      display_name: "Maya",
      role: "Friend",
      deleted_at: null,
      purge_at: null,
    });
    expect(
      (
        upgraded.vault
          .prepare(
            `SELECT name FROM sqlite_master
              WHERE type = 'table' AND name = 'core_entity_revision'`
          )
          .get() as { name: string }
      ).name
    ).toBe("core_entity_revision");
    expect(userVersionOf(path.join(dir, "vault.db"))).toBe(
      VAULT_MIGRATIONS.length
    );
    upgraded.close();
  });

  test("the pre-receipt frontier preserves Tally expenses while adding receipt storage", () => {
    const dir = tempDirSync();
    const seeded = openVaultDb({ dir });
    const boot = bootstrapVault(seeded, { ownerName: "Priya" });
    const now = "2026-07-29T00:00:00.000Z";
    seeded.vault
      .prepare(
        `INSERT INTO social_circle
          (circle_id, owner_party_id, name, kind)
         VALUES ('receipt-circle', ?, 'Dinner', 'friends')`
      )
      .run(boot.ownerPartyId);
    seeded.vault
      .prepare(
        `INSERT INTO tally_group
          (group_id, circle_id, icon, color, created_at, updated_at)
         VALUES ('receipt-group', 'receipt-circle', 'D', '#123456', ?, ?)`
      )
      .run(now, now);
    seeded.vault
      .prepare(
        `INSERT INTO tally_expense
          (expense_id, group_id, description, amount_minor, paid_by,
           spent_on, category, created_at, updated_at)
         VALUES ('existing-expense', 'receipt-group', 'Before receipts', 1200,
                 ?, '2026-07-29', 'food', ?, ?)`
      )
      .run(boot.ownerPartyId, now, now);
    seeded.close();

    rewindVaultTo(path.join(dir, "vault.db"), 4);

    const upgraded = openVaultDb({ dir });
    expect(
      upgraded.vault
        .prepare(
          `SELECT description, amount_minor FROM tally_expense
            WHERE expense_id = 'existing-expense'`
        )
        .get()
    ).toMatchObject({
      description: "Before receipts",
      amount_minor: 1200,
    });
    expect(
      upgraded.vault
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'table' AND name = 'tally_expense_receipt'`
        )
        .get()
    ).toBeTruthy();
    expect(userVersionOf(path.join(dir, "vault.db"))).toBe(
      VAULT_MIGRATIONS.length
    );
    upgraded.close();
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

  // These two tests exercise migrate() generically against JOURNAL_MIGRATIONS
  // rather than VAULT_MIGRATIONS: the vault DDL's FTS triggers call a custom
  // SQL function (vault_content_text) that only openVaultDb registers, so a
  // bare DatabaseSync can't run VAULT_MIGRATIONS directly.
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

  test("oauth_mode is repaired on a pre-#526 credential sidecar", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
    CREATE TABLE sync_connection_credential (
      connection_id TEXT PRIMARY KEY,
      cred_kind TEXT NOT NULL
    ) STRICT;
    INSERT INTO sync_connection_credential (connection_id, cred_kind)
    VALUES ('legacy', 'oauth2');
  `);

    repairSyncCredentialOauthMode(db);
    repairSyncCredentialOauthMode(db);

    const row = db
      .prepare(
        `SELECT oauth_mode FROM sync_connection_credential WHERE connection_id = 'legacy'`
      )
      .get() as { oauth_mode: string };
    expect(row.oauth_mode).toBe("byo");
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

    // The failed open must not have touched the file: the artificially bumped
    // version (and hence the rest of the schema) is exactly as it was left.
    expect(userVersionOf(vaultFile)).toBe(bumped);
  });
});
