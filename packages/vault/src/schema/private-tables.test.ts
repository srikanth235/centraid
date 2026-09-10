// The closed list is only a list if something can falsify it (#996, R3).
//
// Two properties, and they fail in opposite directions. A NAME NO TABLE
// CARRIES is the quieter failure: the sanitiser drops nothing, the canary test
// finds nothing, and the list reads as a decision that was never enforced —
// which is how five `share_commons_*` names survived in the pre-wave
// classification after #929 retired the plane. A REPLICATED TABLE KEYING INTO
// A PRIVATE ONE is the loud one: it is the single property the list exists to
// keep, since a seat runs with `PRAGMA foreign_keys = OFF` and cannot re-check
// what the gateway committed.

import { describe, expect, test } from "vitest";

import { openVaultDb } from "../db.js";
import {
  isReplicatedTable,
  PRIVATE_TABLES,
  PRIVATE_TABLE_NAMES,
  replicatedReferencesToPrivate,
  replicatedTablesOf,
  unclassifiedTables,
} from "./private-tables.js";

describe("the private-table list", () => {
  test("names only tables a fresh vault actually carries", () => {
    const db = openVaultDb();
    try {
      const live = new Set(
        (
          db.vault
            .prepare(`SELECT name FROM sqlite_schema WHERE type = 'table'`)
            .all() as { name: string }[]
        ).map((row) => row.name)
      );
      expect(
        PRIVATE_TABLES.map((entry) => entry.table).filter(
          (table) => !live.has(table)
        )
      ).toStrictEqual([]);
    } finally {
      db.vault.close();
    }
  });

  test("every declaration carries a kind and a reason, and no name twice", () => {
    expect(PRIVATE_TABLE_NAMES.size).toBe(PRIVATE_TABLES.length);
    for (const entry of PRIVATE_TABLES) {
      expect(entry.reason.length, entry.table).toBeGreaterThan(10);
    }
  });

  test("no replicated table references a private one — the property (R3)", () => {
    const db = openVaultDb();
    try {
      expect(replicatedReferencesToPrivate(db.vault)).toStrictEqual([]);
    } finally {
      db.vault.close();
    }
  });

  test("the split registers replicate and their siblings do not", () => {
    const db = openVaultDb();
    try {
      const replicated = new Set(replicatedTablesOf(db.vault));
      // The identity projection travels, so `origin_device_id` and
      // `camera_device_id` resolve on a seat.
      expect(replicated.has("access_device")).toBe(true);
      expect(replicated.has("access_agent")).toBe(true);
      expect(replicated.has("access_device_secret")).toBe(false);
      expect(replicated.has("access_agent_secret")).toBe(false);
      // The log plane and the FTS shadow tables are not data.
      expect(replicated.has("replica_log")).toBe(false);
      expect(
        [...replicated].filter((name) => name.startsWith("fts_"))
      ).toStrictEqual([]);
      // `agent_command_invocation` is replicated on purpose: five replicated
      // tables key into it, and making it private would break the property
      // above rather than protect anything.
      expect(replicated.has("agent_command_invocation")).toBe(true);
    } finally {
      db.vault.close();
    }
  });
});

// THE GOLDEN LIST (#1014, G13). `replicatedTablesOf` used to subtract the
// private list from every table the file carries, so a new table replicated
// to every seat unless someone remembered to classify it. These two tests are
// the falsifier for the other direction: a table added to the schema and
// named on no list fails the build, and a name on the allow-list that no
// table carries is the quiet failure the private list has had since #996.
describe("the replicated allow-list", () => {
  test("every table a fresh vault carries is classified", () => {
    const db = openVaultDb();
    try {
      expect(unclassifiedTables(db.vault)).toStrictEqual([]);
    } finally {
      db.vault.close();
    }
  });

  test("no table is on both lists, and the union is the whole file", () => {
    const db = openVaultDb();
    try {
      const replicated = replicatedTablesOf(db.vault);
      expect(
        replicated.filter((name) => PRIVATE_TABLE_NAMES.has(name))
      ).toStrictEqual([]);
      for (const entry of PRIVATE_TABLES) {
        expect(isReplicatedTable(entry.table), entry.table).toBe(false);
      }
    } finally {
      db.vault.close();
    }
  });

  test("an unclassified table is caught", () => {
    const db = openVaultDb();
    try {
      db.vault.exec(`CREATE TABLE zz_unclassified (id TEXT PRIMARY KEY)`);
      expect(unclassifiedTables(db.vault)).toStrictEqual(["zz_unclassified"]);
      expect(replicatedTablesOf(db.vault)).not.toContain("zz_unclassified");
    } finally {
      db.vault.close();
    }
  });

  test("an app's ext band replicates by prefix", () => {
    expect(isReplicatedTable("ext_gym_workout")).toBe(true);
    expect(isReplicatedTable("extdraft_gym_workout")).toBe(true);
    expect(isReplicatedTable("zz_unclassified")).toBe(false);
  });
});
