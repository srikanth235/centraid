// THE LIFECYCLE CLOSURE (#916, ruling ONT-08 and ONT-15).
//
// Every registry declaration says what a row's life may be. This asserts the
// SHAPE OF A FRESH VAULT agrees with what was declared — and, for the
// append-only half, that no source file quietly edits one in place. That
// second half is why the ruling exists: `deleted_at`/`purge_at` and
// `updated_at` were adopted "as tables are touched" for four releases, so
// what a table's life actually was could only be discovered by reading every
// writer of it. A convention with no test drifts by construction.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { openVaultDb } from "../db.js";
import { ONTOLOGY_PACKS } from "./atlas.js";
import { CREATION_COLUMNS } from "./entity.js";
import { LEDGER_BAND_TABLES } from "./ledger.js";
import { LOCAL_TABLES } from "./local-tables.js";
import { VAULT_ENTITIES, VAULT_TABLES } from "./tables.js";
import { UPDATED_AT_DEFAULT } from "./updated-at.js";

interface ColumnInfo {
  name: string;
  notnull: number;
}

function columnsOf(
  db: ReturnType<typeof openVaultDb>["vault"],
  table: string
): ColumnInfo[] {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as unknown as ColumnInfo[];
}

function triggerNames(
  db: ReturnType<typeof openVaultDb>["vault"],
  table: string
): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?`
      )
      .all(table) as { name: string }[]
  ).map((row) => row.name);
}

/** Every ontology-pack entity, as [logical, physical, lifecycle]. */
function ontologyEntities(): [string, string, string][] {
  const packs = new Set(ONTOLOGY_PACKS);
  return Object.entries(VAULT_ENTITIES)
    .filter(([schema]) => packs.has(schema))
    .flatMap(([schema, entities]) =>
      Object.entries(entities).map(
        ([table, declaration]) =>
          [
            `${schema}.${table}`,
            `${schema}_${table}`,
            declaration.lifecycle,
          ] as [string, string, string]
      )
    );
}

/**
 * Non-test source files of the two packages that hold live write paths.
 * `commands/atlas.ts` is excluded BY DECLARATION, not by exception: the
 * generic Browse editor now refuses an append-only entity itself (see
 * `refuseAppendOnly` there), so the one `UPDATE` it contains is a template
 * over whatever the registry allows rather than a hand-written write path.
 */
function liveSourceFiles(): string[] {
  const roots = [
    path.resolve(import.meta.dirname, ".."),
    path.resolve(import.meta.dirname, "../../../server/src"),
  ];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
      if (/\.test\.ts$|test-fixtures|test-helpers|test-kit/u.test(entry))
        continue;
      if (full.endsWith(path.join("commands", "atlas.ts"))) continue;
      out.push(full);
    }
  };
  for (const root of roots) walk(root);
  return out;
}

const SOURCES: readonly { path: string; text: string }[] = liveSourceFiles()
  .map((file) => ({ path: file, text: readFileSync(file, "utf8") }))
  .filter((file) => file.text.includes("UPDATE"));

function inPlaceWritersOf(physical: string): string[] {
  const pattern = new RegExp(`UPDATE\\s+"?${physical}"?(?![\\w])`, "u");
  return SOURCES.filter((file) => pattern.test(file.text)).map(
    (file) => file.path
  );
}

describe("lifecycle declarations (#916, ruling ONT-08)", () => {
  test("the closure covers the whole ontology and the whole source tree", () => {
    // A closure test that silently walked nothing would pass forever.
    expect(ontologyEntities().length).toBeGreaterThan(50);
    expect(SOURCES.length).toBeGreaterThan(20);
    // And the scanner sees a real in-place writer where one exists.
    expect(inPlaceWritersOf("core_party").length).toBeGreaterThan(0);
  });

  test("every ontology-pack entity declares one of the four lifecycles", () => {
    for (const [logical, , lifecycle] of ontologyEntities()) {
      expect(
        ["append-only", "mutable", "trash"],
        `${logical} is life data, not machinery`
      ).toContain(lifecycle);
    }
  });

  test("trash carries the pair, its CHECK, and the changed-at machinery", () => {
    const db = openVaultDb();
    for (const [logical, physical, lifecycle] of ontologyEntities()) {
      if (lifecycle !== "trash") continue;
      const names = columnsOf(db.vault, physical).map((c) => c.name);
      expect(names, `${logical}.deleted_at`).toContain("deleted_at");
      expect(names, `${logical}.purge_at`).toContain("purge_at");
      const sql = (
        db.vault
          .prepare(
            `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`
          )
          .get(physical) as { sql: string }
      ).sql;
      // The guard that makes the pair a PAIR: a purge date without a trash
      // date would schedule a live row for deletion.
      expect(sql.replace(/\s+/gu, " "), `${logical} purge_at CHECK`).toContain(
        "purge_at IS NULL OR deleted_at IS NOT NULL"
      );
    }
    db.close();
  });

  test("mutable and trash record when they changed, always", () => {
    const db = openVaultDb();
    const violations: string[] = [];
    for (const [logical, physical, lifecycle] of ontologyEntities()) {
      if (lifecycle === "append-only") continue;
      const updatedAt = columnsOf(db.vault, physical).find(
        (c) => c.name === "updated_at"
      );
      if (!updatedAt) {
        violations.push(`${logical} is ${lifecycle} but has no updated_at`);
        continue;
      }
      const triggers = new Set(triggerNames(db.vault, physical));
      if (!triggers.has(`${physical}_touch_updated_at`)) {
        violations.push(`${logical} has updated_at but nothing touches it`);
      }
    }
    expect(violations, violations.join("\n")).toStrictEqual([]);
    db.close();
  });

  // ONE `updated_at`, everywhere (#916, ruling ONT-08, rung nine).
  //
  // The column had three shapes at once: NOT NULL with the canonical default
  // (Tally, and People after #821), bare NOT NULL (every writer had to
  // remember to pass it), and — after rung eight's ADD COLUMNs — nullable with
  // a stamp trigger standing in for the default it could not carry. Rung nine
  // rebuilt all of them into the first shape, so the rule below needs no
  // allow-list and no lifecycle split: if a column is called `updated_at`, in
  // EITHER file, this is what it is.
  //
  // `replica_meta` is the one exception, and it is a mechanism exception, not
  // a taste one: every replica change-log trigger in the vault reads that
  // table — including the ones generated at runtime for live ext-band tables,
  // whose names no build-time list can know — so the rebuild's rename pass
  // would have to re-parse triggers this build cannot enumerate. Its
  // `updated_at` is also not a generic changed-at: the replica protocol writes
  // it explicitly on every epoch transition.
  const UPDATED_AT_EXCEPTIONS: ReadonlyMap<string, string> = new Map([
    [
      "replica_meta",
      "every replica trigger, including runtime ext-band ones, reads it",
    ],
  ]);

  test("one updated_at shape in the whole vault, with no allow-list", () => {
    const db = openVaultDb();
    const violations: string[] = [];
    for (const handle of [db.vault]) {
      const rows = handle
        .prepare(
          `SELECT name, sql FROM sqlite_master WHERE type = 'table'
             AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'fts\\_%' ESCAPE '\\'`
        )
        .all() as { name: string; sql: string | null }[];
      for (const { name, sql } of rows) {
        const column = columnsOf(handle, name).find(
          (c) => c.name === "updated_at"
        );
        if (!column) continue;
        if (UPDATED_AT_EXCEPTIONS.has(name)) continue;
        // The `ledger` band is engine-owned and runs on the gateway's epoch-ms
        // clock, like `core_share_origin.shared_at` and `blob_orphan.
        // first_orphaned_at`: its `updated_at` is an INTEGER, not the
        // ontology's ISO-8601 TEXT, and the store code stamps it explicitly on
        // every write. The ontology's one shape is a rule about ontology rows.
        if (LEDGER_BAND_TABLES.includes(name)) continue;
        const declaration = (sql ?? "")
          .split("\n")
          .map((line) => line.trim())
          .find((line) => /^"?updated_at"?\s/u.test(line));
        if (
          declaration === undefined ||
          !declaration.includes(`NOT NULL DEFAULT ${UPDATED_AT_DEFAULT}`)
        ) {
          violations.push(
            `${name}.updated_at is "${declaration ?? "?"}" — the one shape is NOT NULL DEFAULT ${UPDATED_AT_DEFAULT} (#916, ruling ONT-08)`
          );
        }
        if (!triggerNames(handle, name).includes(`${name}_touch_updated_at`)) {
          violations.push(`${name}.updated_at has no touch trigger`);
        }
      }
    }
    expect(violations, violations.join("\n")).toStrictEqual([]);
    // The exception list is a claim about the file; a stale entry is a lie.
    for (const table of UPDATED_AT_EXCEPTIONS.keys()) {
      expect(
        columnsOf(db.vault, table).map((c) => c.name),
        `${table} no longer carries updated_at — drop its exception`
      ).toContain("updated_at");
    }
    db.close();
  });

  // `CREATION_COLUMNS` (schema/entity.ts) names the tables whose creation
  // stamp has a DOMAIN name. `created_at` is the rule (#916, ruling ONT-08,
  // rung nine): a row that records when it changed but not when it began
  // answers half a question. These predate the rule and already answer the
  // whole one — `tagged_at` IS when the tag was made — so renaming them would
  // be churn that costs every reader. A table with neither is a violation, not
  // an entry there. The map lives beside the supertype because rung ten's
  // membership trigger reads the same column to stamp `core_entity.created_at`,
  // and two copies of that list would drift.

  test("every ontology-pack table records when the row began", () => {
    const db = openVaultDb();
    const violations: string[] = [];
    for (const [logical, physical] of ontologyEntities()) {
      const names = columnsOf(db.vault, physical).map((c) => c.name);
      if (names.includes("created_at")) continue;
      const domainName = CREATION_COLUMNS.get(physical);
      if (domainName !== undefined && names.includes(domainName)) continue;
      violations.push(
        `${logical} has no created_at and no declared creation column — add the column in a rung, or name its domain-spelled one in CREATION_COLUMNS with the reason`
      );
    }
    expect(violations, violations.join("\n")).toStrictEqual([]);
    db.close();
  });

  test("append-only rows are never edited in place — column or code", () => {
    const db = openVaultDb();
    const violations: string[] = [];
    for (const [logical, physical, lifecycle] of ontologyEntities()) {
      if (lifecycle !== "append-only") continue;
      const names = columnsOf(db.vault, physical).map((c) => c.name);
      if (names.includes("updated_at")) {
        violations.push(
          `${logical} declares append-only but carries updated_at — a row written once has no changed-at`
        );
      }
      for (const file of inPlaceWritersOf(physical)) {
        violations.push(
          `${logical} declares append-only but ${path.relative(path.resolve(import.meta.dirname, "../../../.."), file)} runs UPDATE ${physical} — either the write is wrong or the declaration is`
        );
      }
    }
    expect(violations, violations.join("\n")).toStrictEqual([]);
    db.close();
  });

  test("every physical table is registered or declared local (ONT-15)", () => {
    const db = openVaultDb();
    const registered = new Set(
      Object.entries(VAULT_TABLES).flatMap(([schema, tables]) =>
        tables.map((table) => `${schema}_${table}`)
      )
    );
    const physical = (
      db.vault
        .prepare(
          `SELECT name FROM sqlite_master WHERE type IN ('table','virtual')
             AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'fts\\_%' ESCAPE '\\'`
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    const unaccounted = physical.filter(
      (name) => !registered.has(name) && !LOCAL_TABLES.has(name)
    );
    expect(
      unaccounted,
      `unregistered and undeclared: ${unaccounted.join(", ")} — add the entity to the registry, or name it in LOCAL_TABLES with the reason it stays out of the canonical walk`
    ).toStrictEqual([]);
    // And the reverse: a local declaration for a table that no longer exists
    // is a stale claim about the file.
    const live = new Set(physical);
    expect(
      [...LOCAL_TABLES.keys()].filter((name) => !live.has(name))
    ).toStrictEqual([]);
    db.close();
  });
});
