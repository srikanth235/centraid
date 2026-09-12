// Export the `ledger` band's shape as one language-neutral fixture (#1020,
// wave 4 lane assist, D-1020-AS3).
//
// ## What this is, and what it deliberately is not
//
// It is NOT a copy of the DDL. The DDL is
// `contracts/migrations/001_baseline.sql`, which is both the migration and the
// fixture already (D-1020-D1-13) and carries the band's fourteen tables because
// wave 2 exported the whole corpus at once. A second copy of that text would be
// a second answer to one question.
//
// What has no home yet is the band's **declared shape**: the fourteen table
// names in the order `ledger.ts:23`–`:37` lists them, the closed vocabularies
// and which column each belongs to, the delete rules and the one edge that
// deliberately has none, the two indexes with their predicates, the eight
// triggers, and the five tables the automations lane owns the store code over.
// Every one of those is a sentence in a TypeScript comment today, which means
// nothing can be held to it. This fixture is what both sides are held to:
// `crates/vault/tests/ledger.rs` checks a founded vault against it, and while
// v0 exists the TypeScript oracle answers the same file.
//
// Regenerate with:
//
//   bun contracts/tools/export-ledger-fixture.ts > contracts/assist/ledger-fixture.json
//   bun run format
//
// Then `git diff --exit-code contracts/assist` is the check that it is current.

import { readFileSync } from "node:fs";

const SOURCE = "packages/vault/src/schema/ledger.ts";
const source = readFileSync(SOURCE, "utf8");

/** The `LEDGER_BAND_TABLES` array literal, read from the source rather than typed. */
function tableNames(): string[] {
  const at = source.indexOf("LEDGER_BAND_TABLES");
  if (at === -1) throw new Error(`no LEDGER_BAND_TABLES in ${SOURCE}`);
  // `= [`, not the first `[`: the declaration's own type annotation is
  // `readonly string[]`, whose empty brackets come first and would slice out
  // nothing at all — a fixture with zero tables that looks generated.
  const open = source.indexOf("= [", at) + 2;
  const close = source.indexOf("]", open);
  const names = source
    .slice(open + 1, close)
    .split(",")
    .map((entry) => entry.trim().replace(/^["']|["']$/gu, ""))
    .filter((entry) => entry.length > 0 && !entry.startsWith("//"));
  if (names.length === 0)
    throw new Error(`LEDGER_BAND_TABLES parsed empty in ${SOURCE}`);
  return names;
}

/**
 * Every `CHECK (<column> IN (…))` in the band's DDL, as a closed vocabulary.
 *
 * Read out of the SQL rather than declared here, so a value added to a CHECK in
 * v0 appears in the fixture and the Rust test fails until the enum grows.
 */
function vocabularies(): { column: string; values: string[] }[] {
  const found: { column: string; values: string[] }[] = [];
  const pattern =
    /CHECK\s*\(\s*(?:(?<nullable>\w+)\s+IS\s+NULL\s+OR\s+)?(?<column>\w+)\s+IN\s*\((?<values>[^)]*)\)/gu;
  for (const match of source.matchAll(pattern)) {
    const column = match.groups?.column;
    const values = (match.groups?.values ?? "")
      .split(",")
      .map((entry) => entry.trim().replace(/^'|'$/gu, ""))
      .filter((entry) => entry.length > 0);
    if (column && values.length > 0) {
      found.push({
        column,
        values,
        nullable: Boolean(match.groups?.nullable),
      } as never);
    }
  }
  return found;
}

/** Every `REFERENCES <table>(<column>)` and whether it cascades. */
function deleteRules(): { references: string; onDelete: string }[] {
  const found: { references: string; onDelete: string }[] = [];
  const pattern =
    /REFERENCES\s+(?<table>\w+)\((?<column>[^)]+)\)(?<cascade>\s+ON DELETE CASCADE)?/gu;
  for (const match of source.matchAll(pattern)) {
    found.push({
      references: `${match.groups?.table}(${match.groups?.column?.trim()})`,
      onDelete: match.groups?.cascade ? "cascade" : "none",
    });
  }
  return found;
}

/** Every `CREATE TRIGGER <name>` and `CREATE INDEX`/`CREATE UNIQUE INDEX`. */
function objects(keyword: string): string[] {
  const found: string[] = [];
  const pattern = new RegExp(
    `CREATE\\s+(?:UNIQUE\\s+)?${keyword}\\s+(?<name>\\w+)`,
    "gu"
  );
  for (const match of source.matchAll(pattern)) {
    const name = match.groups?.name;
    if (name) found.push(name);
  }
  return found.sort();
}

const tables = tableNames();

process.stdout.write(
  `${JSON.stringify(
    {
      origin: {
        source: SOURCE,
        generator: "contracts/tools/export-ledger-fixture.ts",
        issue: "https://github.com/srikanth235/centraid/issues/1020",
        note: "GENERATED — do not edit. The DDL itself lives in contracts/migrations/001_baseline.sql; this is the band's declared shape.",
      },
      band: "ledger",
      // Machinery: registered names-only, excluded from the portable export and
      // from the replica BY BAND, exactly as `audit` is — and **mutable**, so
      // unlike `audit` it carries no append-only trigger, because a turn is
      // amended as it streams.
      registration: "names-only",
      mutable: true,
      tables,
      tableCount: tables.length,
      // The five tables whose store code the automations lane owns
      // (§Cross-lane). One band, one migration, one retention pass.
      automationOwned: [
        "harness_health",
        "conversation_provider_consent",
        "automation_state",
        "automation_trigger_cursor",
        "trigger_ingress",
      ],
      vocabularies: vocabularies(),
      deleteRules: deleteRules(),
      // `turns.parent_turn_id` is a PLAIN COLUMN with no foreign key: a
      // sub-run's parent may be recorded after this row inside one batch, and a
      // constraint would refuse the batch.
      plainColumns: ["turns.parent_turn_id", "items.child_turn_id"],
      indexes: objects("INDEX"),
      triggers: objects("TRIGGER"),
      views: objects("VIEW"),
      // Not UNIQUE, on purpose: automations and legacy rows leave it NULL.
      indexedNotUnique: ["turns.idempotency_key"],
      // NULL means the harness did not confirm a selectable effort. Never
      // infer a default.
      neverInferred: ["items.effort"],
    },
    null,
    2
  )}\n`
);
