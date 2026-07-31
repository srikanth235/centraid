import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { openVaultDb } from "../db.js";
import { VAULT_MIGRATIONS } from "./migrate.js";

function userVersionOf(file: string): number {
  const raw = new DatabaseSync(file);
  const row = raw.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  raw.close();
  return row.user_version;
}

describe("schema/migrate — inbox → notifications (#665)", () => {
  test("a vault holding the old inbox_notice table upgrades to notifications_notice", () => {
    // Issue #665 renamed the surface Inbox → Notifications and the table with
    // it. v0 owes no data migration, so the rung must DROP the old table
    // without crashing and leave the new one in place.
    // Split out of migrate.test.ts so that file stays under the 625-line
    // repo-hygiene ceiling (it was already at the limit on main).
    const dir = tempDirSync();
    const seeded = openVaultDb({ dir });
    seeded.close();
    const file = path.join(dir, "vault.db");
    const raw = new DatabaseSync(file);
    raw.exec(`
      DROP INDEX notifications_notice_active_idx;
      DROP INDEX notifications_notice_retention_idx;
      DROP TABLE notifications_notice;
      CREATE TABLE inbox_notice (notice_id TEXT PRIMARY KEY) STRICT;
      INSERT INTO inbox_notice(notice_id) VALUES ('stale');
      PRAGMA user_version = ${VAULT_MIGRATIONS.length - 1};
    `);
    raw.close();

    const upgraded = openVaultDb({ dir });
    const tables = upgraded.vault
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name IN ('inbox_notice','notifications_notice')`
      )
      .all() as { name: string }[];
    expect(tables.map((row) => row.name)).toStrictEqual([
      "notifications_notice",
    ]);
    // The rebuildable projection starts over rather than being copied.
    expect(
      (
        upgraded.vault
          .prepare(`SELECT count(*) AS n FROM notifications_notice`)
          .get() as { n: number }
      ).n
    ).toBe(0);
    expect(userVersionOf(file)).toBe(VAULT_MIGRATIONS.length);
    upgraded.close();
  });
});
