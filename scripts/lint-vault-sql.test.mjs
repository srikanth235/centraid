import assert from "node:assert/strict";
import test from "node:test";

import {
  ALLOW_LIST,
  collectTableReferences,
  lintVaultSql,
  parseVaultTables,
  stripComments,
} from "./lint-vault-sql.mjs";

const TABLES = ["core_event", "core_party", "schedule_task"];
const rules = (result) => result.findings.map((finding) => finding.rule).sort();

test("the registry reader joins schema and entity into the physical name", () => {
  const parsed = parseVaultTables(
    [
      "const other = { core: { nope: {} } };",
      "export const VAULT_ENTITIES: EntityRegistry = {",
      "  core: {",
      '    party: { lifecycle: "mutable", label: "People" },',
      "    event: {",
      '      lifecycle: "trash",',
      '      label: "Events",',
      "    },",
      "  },",
      "  blob: {",
      '    custody_state: { label: "Custody", lifecycle: "machinery" },',
      "  },",
      "};",
      "export const JOURNAL_ENTITIES = {",
      "  journal: {",
      "    entry: {},",
      "  },",
      "};",
    ].join("\n")
  );
  assert.deepEqual(parsed, ["core_party", "core_event", "blob_custody_state"]);
});

test("a registry shape the reader cannot follow yields nothing, which the guard turns into a failure", () => {
  assert.deepEqual(parseVaultTables("export const SOMETHING_ELSE = {};"), []);
});

test("comments are stripped and string bodies are kept", () => {
  const stripped = stripComments(
    [
      "// FROM core_event",
      "/* FROM core_party */",
      'q("FROM schedule_task");',
    ].join("\n")
  );
  assert.ok(!stripped.includes("core_event"));
  assert.ok(!stripped.includes("core_party"));
  assert.ok(stripped.includes("schedule_task"));
});

test("a table named only in prose is not a reference", () => {
  assert.deepEqual(
    collectTableReferences("// a note about FROM core_event\n", TABLES),
    []
  );
});

test("a reference carries the table and the line it first appears on", () => {
  assert.deepEqual(
    collectTableReferences(
      ["const a = 1;", 'const q = "SELECT 1 FROM core_event";'].join("\n"),
      TABLES
    ),
    [{ table: "core_event", line: 2 }]
  );
});

test("every SQL clause that can introduce a table is matched", () => {
  for (const sql of [
    "SELECT * FROM core_event",
    "SELECT * FROM x JOIN core_event ON x.id = core_event.id",
    "INSERT INTO core_event(a) VALUES (1)",
    "UPDATE core_event SET a = 1",
    "CREATE TABLE IF NOT EXISTS core_event (a TEXT)",
  ]) {
    assert.deepEqual(
      collectTableReferences(`q("${sql}")`, TABLES).map((ref) => ref.table),
      ["core_event"],
      sql
    );
  }
});

test("a join predicate is not read as a table reference", () => {
  assert.deepEqual(
    collectTableReferences('q("SELECT 1 FROM t ON core_event.id = t.id")', [
      "core_event",
    ]).map((ref) => ref.table),
    []
  );
});

test("an unlisted file fails and the finding names the tables", () => {
  const result = lintVaultSql({
    files: [{ rel: "src/read.ts", text: 'q("SELECT * FROM core_event")' }],
    tables: TABLES,
    allow: {},
    roles: [],
  });
  assert.deepEqual(rules(result), ["raw-vault-sql"]);
  assert.deepEqual(result.findings[0].tables, ["core_event"]);
  assert.match(result.findings[0].message, /walks past the gateway/u);
});

test("the allow-list reports which of its entries are still earning their place", () => {
  const result = lintVaultSql({
    files: [
      { rel: "used.ts", text: 'q("SELECT * FROM core_event")' },
      { rel: "clean.ts", text: "const x = 1;" },
    ],
    tables: TABLES,
    allow: { "used.ts": "owns it", "clean.ts": "used to own it" },
    roles: [],
  });
  assert.deepEqual(rules(result), []);
  assert.deepEqual([...result.allowed], ["used.ts"]);
});

test("every shipped allow-list entry carries a reason and a distinct path", () => {
  for (const [file, reason] of Object.entries(ALLOW_LIST)) {
    assert.ok(reason.length > 10, `${file} needs a real reason`);
    assert.ok(
      !file.startsWith("packages/vault/"),
      `${file} is inside the vault and needs no allowance`
    );
  }
});

test("the three life-data readers the review named are NOT allow-listed", () => {
  for (const file of [
    "packages/server/src/brief/daily-brief.ts",
    "packages/server/src/reminders/due-reminders.ts",
    "packages/server/src/enrich/semantic-search.ts",
  ]) {
    assert.ok(!(file in ALLOW_LIST), `${file} must not be allow-listed`);
  }
});
