#!/usr/bin/env node
// The vault's registry is an allow-list, held from outside the vault too
// (vault-ontology review, lens 8.1).
//
// Why this exists: every physical table is declared once, in
// `packages/vault/src/schema/entity-catalog.ts`, and the gateway is the only
// door to them — where consent is resolved, a receipt is written, and soft-
// deleted rows are filtered out. A `db.vault.prepare("SELECT … FROM
// core_event")` written ANYWHERE ELSE walks past all three at once, and nothing
// in the type system notices: the string is just a string. Not hypothetical —
// the review found life-data readers doing exactly this, serving trashed rows
// with no consent check and no receipt.
//
//   RULE raw-vault-sql   No file outside `packages/vault` may name a physical
//     vault table inside raw SQL, unless it is in the ALLOW-LIST below with a
//     reason. The table vocabulary is READ FROM the registry, never hand-listed
//     here, so a table added tomorrow is covered the day it is declared.
//
// The allow-list is the whole design. Plane machinery legitimately lives outside
// the vault and owns tables the vault does not manage (share, replica, broker,
// notices); restore, doctor and quarantine work *below* the gateway by
// definition. Each is named with one clause saying why. A product surface that
// just wants to read life data is NOT on the list, and adding it there is the
// change a reviewer gets to argue with.
//
// WHAT THIS CANNOT SEE, said plainly: it matches text, not a query plan. SQL
// assembled from fragments, a table name held in a variable, or a view over a
// vault table all read as clean — the cheap tripwire in front of review, exactly
// like lint-mobile-testids.mjs, not a proof.
//
// Following that linter: A SILENT NO-OP IS A FAILURE. Zero tables parsed, zero
// source files discovered, zero references found, an allow-list entry naming a
// missing file, or an entry whose file no longer speaks SQL each FAIL rather
// than pass — every one is the shape this linter takes once its readers or the
// tree moved under it, and an allowance that has outlived its reason is how an
// allow-list rots into a permission slip.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

/** The registry. The one place a physical table name is declared. */
const REGISTRY = "packages/vault/src/schema/entity-catalog.ts";

/**
 * Vault-plane storage that is NOT in the registry: the replica mirror and the
 * blob/share/consent/sync/outbox/notice machinery. Prefix-matched — these
 * families grow by table, and the whole family has one owner.
 */
// prettier-ignore
const PHYSICAL_PREFIXES = [
  "blob_", "replica_", "share_", "consent_", "access_",
  "enrich_", "sync_", "outbox_", "notifications_",
];

// prettier-ignore
const SKIP_DIRS = new Set([
  ".git", ".turbo", "artifacts", "build", "dist", "node_modules",
]);
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/u;
/** The vault owns its own tables; that is the point. */
const VAULT_DIR = "packages/vault/";

/**
 * Whole trees of TEST code, allowed by role rather than by file. A suite that
 * asserts the gateway actually wrote `core_event` has to read `core_event`;
 * listing several hundred such files one by one would bury the handful of
 * production allowances that are the reason this linter exists.
 */
const TEST_ROLES = [
  {
    pattern: /\.test\.[cm]?[jt]sx?$/u,
    reason: "a suite proves a gateway write landed by reading the row it wrote",
  },
  {
    pattern: /^tests\//u,
    reason: "the perf, scale and quality trees seed and verify vaults directly",
  },
  {
    pattern: /^packages\/test-kit\//u,
    reason: "the shared test kit builds the fixture vaults the suites read",
  },
  {
    pattern: /^scripts\/(?:corpora|golden-vault)\//u,
    reason: "corpus builders write the fixture vaults committed for the suites",
  },
];

/**
 * Production files allowed to speak SQL, each with the clause that earns it.
 * Seeded from the review's own census; anything not here fails.
 */
export const ALLOW_LIST = {
  // ── the replica plane: a local mirror the vault does not manage ──
  "apps/mobile/src/lib/replica/sqlite-intent-store.ts":
    "owns the phone's replica intent outbox tables",
  "packages/client/src/replica/store-core.ts":
    "owns the client's replica mirror tables",
  "packages/server/src/routes/replica-intent-shape.ts":
    "reads the invocation commit log the replica acknowledges against",
  "packages/server/src/routes/replica-projection.ts":
    "reads the install register a replica shape is controlled by",
  "packages/server/src/routes/replica-routes.ts":
    "streams the change log rows that ARE the replica protocol",
  "packages/server/src/routes/replica-shape.ts":
    "answers what a replica may hold, from the install register and the change log",
  // ── the share / commons plane: server-owned tables, not vault entities ──
  "packages/server/src/serve/gateway-schema.ts":
    "creates the server-owned share-plane tables themselves",
  "packages/server/src/serve/share-access-receipts.ts":
    "owns share_access_receipts, the same-owner placement history",
  "packages/server/src/serve/grant-fulfillment.ts":
    "owns share_authority and share_fulfillment",
  "packages/server/src/serve/share-notices.ts":
    "names the party a share notice is about",
  "packages/server/src/routes/commons-routes.ts":
    "serves the commons control tables the share plane owns",
  "packages/server/src/routes/peer-commons-route.ts":
    "answers a peer from the commons membership tables",
  "packages/server/src/serve/peer-commons-client.ts":
    "is the commons transport's own client",
  "packages/server/src/serve/peer-commons-sweep.ts":
    "sweeps expired commons intents",
  "packages/server/src/serve/commons-notices.ts":
    "raises notices from commons invitations",
  "packages/server/src/serve/commons-observability.ts":
    "reports the commons plane's own health counters",
  "packages/server/src/serve/commons-recovery-invites.ts":
    "issues steward recovery invitations from commons bindings",
  // ── connection broker + outbox: the sync plane's own storage ──
  "packages/server/src/serve/connection-broker.ts":
    "owns sync_connection and its credential rows",
  "packages/server/src/serve/broker-health.ts":
    "reports the broker's own connection health",
  "packages/server/src/serve/build-gateway.ts":
    "counts broker and outbox rows for the gateway's status surface",
  "packages/server/src/routes/connections-routes.ts":
    "serves the broker's connection rows",
  "packages/server/src/serve/outbox-executor.ts":
    "drains outbox_item, the table it owns",
  "packages/server/src/serve/notices.ts": "owns notifications_notice",
  // ── below the gateway by definition: plane, doctor, backup, quarantine ──
  "packages/server/src/serve/vault-plane.ts":
    "mounts vaults and reads plane state before any gateway exists",
  "packages/server/src/serve/vault-quarantine.ts":
    "quarantines a vault whose gateway must not be trusted",
  "packages/server/src/doctor/integrity-checks.ts":
    "checks the physical database, which is its whole job",
  "packages/server/src/backup/restore-drill.ts":
    "verifies restored rows below the gateway",
  "packages/server/src/backup/restore-warm.ts":
    "warms derivative rows during a restore",
  "packages/server/src/cli/key-admin.ts":
    "reads vault identity before a gateway can be built",
  "packages/server/src/serve/support-bundle-source.ts":
    "must read the person names it then redacts",
  // ── harnesses and fixtures that are test code by role, not by suffix ──
  "packages/server/src/acp/prompt-injection/harness.ts":
    "seeds the throwaway vault the injection corpus runs against",
  "packages/server/src/serve/outbox-executor-test-kit.ts":
    "is the outbox executor's test kit",
  "packages/server/src/serve/commons-b6.test-fixtures.ts":
    "is a commons suite's fixture builder",
  "packages/server/src/serve/peer-give.test-fixtures.ts":
    "is a peer-give suite's fixture builder",
  "packages/server/src/serve/vault-plane.test-fixtures.ts":
    "is a vault-plane suite's fixture builder",
  "apps/mobile/src/lib/replica/locker-vault.test-fixtures.ts":
    "is the Locker replica fixture builder; it seeds replica_row directly after bootstrap",
  "apps/mobile/src/lib/replica/tally-ledger.test-fixtures.ts":
    "is the Tally replica fixture builder; it seeds replica_row directly after bootstrap",
  // ── this linter ──
  "scripts/lint-vault-sql.mjs":
    "its own fixtures name physical tables on purpose",
};

// ── the vocabulary ─────────────────────────────────────────────────────────

/**
 * Physical table names from `VAULT_ENTITIES` — `schema_entity`, the same join
 * `tableNamesOf` performs at runtime. Read line-by-line rather than with a TS
 * parser to keep this script dependency-free like its siblings; the registry is
 * a literal object by construction. A shape it cannot read yields zero names,
 * which the empty-vocabulary guard turns into a failure.
 *
 * Exported so the sibling test can drive it on fixtures.
 */
export function parseVaultTables(text) {
  const start = text.indexOf("export const VAULT_ENTITIES");
  if (start < 0) return [];
  const names = [];
  let schema = "";
  for (const line of text.slice(start).split("\n")) {
    if (line.startsWith("};")) break;
    const top = /^ {2}(?<name>[a-z0-9_]+): \{/u.exec(line);
    if (top?.groups) {
      schema = top.groups.name;
      continue;
    }
    const entity = /^ {4}(?<name>[a-z0-9_]+): \{/u.exec(line);
    if (entity?.groups && schema !== "")
      names.push(`${schema}_${entity.groups.name}`);
  }
  return names;
}

/** Source files to scan, relative to `root`, discovered from disk. */
export function discoverSourceFiles(root = ROOT) {
  const out = [];
  const walk = (abs) => {
    for (const entry of readdirSync(abs).sort()) {
      if (SKIP_DIRS.has(entry)) continue;
      const child = path.join(abs, entry);
      if (statSync(child).isDirectory()) {
        walk(child);
        continue;
      }
      const rel = path.relative(root, child).replaceAll("\\", "/");
      if (SOURCE_EXT.test(rel) && !rel.startsWith(VAULT_DIR)) out.push(rel);
    }
  };
  walk(root);
  return out;
}

// ── the grammar ────────────────────────────────────────────────────────────

/**
 * The file with its comments removed, string and template bodies kept intact.
 * Prose quotes SQL constantly in this repo ("FKs into core_party"), and a
 * comment naming a table is a comment, not a query. Strings are preserved
 * because a query IS a string.
 */
export function stripComments(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const here = text[i];
    const next = text[i + 1];
    if (here === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (here === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/"))
        i += 1;
      i += 2;
      continue;
    }
    if (here === '"' || here === "'" || here === "`") {
      out += here;
      i += 1;
      while (i < text.length) {
        if (text[i] === "\\") {
          out += text[i] + (text[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += text[i];
        i += 1;
        if (text[i - 1] === here) break;
      }
      continue;
    }
    out += here;
    i += 1;
  }
  return out;
}

// Uppercase keywords only: raw SQL in this repo is written `FROM core_event`,
// while English prose that happens to precede a table name ("into core_party")
// is lower-case. `ON` is deliberately absent — `JOIN x ON y.id` would make every
// join predicate look like a table reference.
const TABLE_RE =
  /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"'[]?(?<table>[a-z][a-z0-9_]*)/gu;

/**
 * Physical vault tables a file names in raw SQL, with the line of each first
 * mention. `tables` is the registry vocabulary; prefixes are applied on top.
 */
export function collectTableReferences(text, tables) {
  const known = new Set(tables);
  const stripped = stripComments(text);
  const found = new Map();
  TABLE_RE.lastIndex = 0;
  let match;
  while ((match = TABLE_RE.exec(stripped))) {
    const name = match.groups?.table ?? "";
    if (!known.has(name) && !PHYSICAL_PREFIXES.some((p) => name.startsWith(p)))
      continue;
    if (found.has(name)) continue;
    const line = stripped.slice(0, match.index).split("\n").length;
    found.set(name, line);
  }
  return [...found].map(([table, line]) => ({ table, line }));
}

// ── the rule ───────────────────────────────────────────────────────────────

/**
 * Hold the tree against the allow-list. Pure: the caller reads the disk, this
 * decides. `files` is `{ rel, text }[]`; `allow` is the `{ file, reason }[]`
 * and `roles` the `{ pattern, reason }[]`.
 *
 * @returns `{ findings, references, allowed }` — `allowed` is the set of
 *   allow-list files that actually still contain vault SQL, which is how the
 *   caller catches an allowance that has outlived its reason.
 */
export function lintVaultSql({
  files,
  tables,
  allow = ALLOW_LIST,
  roles = TEST_ROLES,
}) {
  const allowed = new Map(Object.entries(allow));
  const findings = [];
  const used = new Set();
  let references = 0;

  for (const file of files) {
    const refs = collectTableReferences(file.text, tables);
    if (refs.length === 0) continue;
    references += refs.length;
    if (roles.some((role) => role.pattern.test(file.rel))) continue;
    if (allowed.has(file.rel)) {
      used.add(file.rel);
      continue;
    }
    findings.push({
      file: file.rel,
      line: refs[0].line,
      rule: "raw-vault-sql",
      tables: refs.map((ref) => ref.table),
      message:
        `names physical vault table(s) ${refs.map((ref) => ref.table).join(", ")} in raw SQL. ` +
        `Reaching the tables directly walks past the gateway — no consent resolution, ` +
        `no receipt, and no soft-delete filter. Go through the vault gateway, or add ` +
        `this file to ALLOW_LIST in scripts/lint-vault-sql.mjs with the clause that earns it.`,
    });
  }

  return { findings, references, allowed: used };
}

// ── self-test: the rule, exercised before it judges the repo ───────────────
// A linter that silently stops enforcing is worse than none. Runs on every
// invocation (µs); the guards and the readers are covered more thoroughly by
// the sibling `lint-vault-sql.test.mjs`.
function selfTest() {
  const tables = ["core_event", "schedule_task"];
  const allow = { "ok.ts": "owns the table" };
  const roles = [{ pattern: /\.test\.ts$/u, reason: "a suite" }];
  const cases = [
    {
      name: "an unlisted file naming a vault table fails",
      files: [{ rel: "bad.ts", text: 'q("SELECT * FROM core_event")' }],
      want: ["raw-vault-sql"],
    },
    {
      name: "an allow-listed file passes",
      files: [{ rel: "ok.ts", text: 'q("SELECT * FROM core_event")' }],
      want: [],
    },
    {
      name: "a test-role file passes",
      files: [{ rel: "a.test.ts", text: 'q("SELECT * FROM core_event")' }],
      want: [],
    },
    {
      name: "a prefix family outside the registry still fails",
      files: [{ rel: "bad.ts", text: 'q("INSERT INTO share_edges(id)")' }],
      want: ["raw-vault-sql"],
    },
    {
      name: "a table named only in a comment is not a query",
      files: [
        { rel: "bad.ts", text: "// reads FROM core_event\nconst x = 1;" },
      ],
      want: [],
    },
    {
      name: "a table-shaped word that is not a vault table passes",
      files: [{ rel: "bad.ts", text: 'q("SELECT * FROM owners")' }],
      want: [],
    },
  ];
  for (const testCase of cases) {
    const got = lintVaultSql({ files: testCase.files, tables, allow, roles })
      .findings.map((finding) => finding.rule)
      .sort();
    if (JSON.stringify(got) !== JSON.stringify([...testCase.want].sort())) {
      console.error(
        `FAIL — lint-vault-sql self-test "${testCase.name}": expected [${testCase.want}], got [${got}]`
      );
      process.exit(1);
    }
  }
  // The registry reader is half the linter; a shape it cannot read yields zero
  // names and every file then passes vacuously.
  const parsed = parseVaultTables(
    [
      "export const VAULT_ENTITIES: EntityRegistry = {",
      "  core: {",
      '    party: { lifecycle: "mutable", label: "People" },',
      "    event: {",
      '      lifecycle: "trash",',
      "    },",
      "  },",
      "};",
    ].join("\n")
  );
  if (JSON.stringify(parsed) !== JSON.stringify(["core_party", "core_event"])) {
    console.error(
      `FAIL — lint-vault-sql self-test "registry reader": expected core_party, core_event; got ${parsed.join(", ")}`
    );
    process.exit(1);
  }
}

function fail(message) {
  console.error(`FAIL — ${message}`);
  process.exit(1);
}

function main() {
  selfTest();

  const registryPath = path.resolve(ROOT, REGISTRY);
  if (!existsSync(registryPath))
    fail(`${REGISTRY} does not exist — the registry is the vocabulary.`);
  const tables = parseVaultTables(readFileSync(registryPath, "utf8"));
  if (tables.length === 0)
    fail(
      `${REGISTRY} yielded zero table names. The registry moved or its shape ` +
        `changed and this linter's reader is stale, not clean.`
    );

  const rels = discoverSourceFiles();
  if (rels.length === 0)
    fail(
      `discovered zero source files under ${ROOT}. The tree moved; fix the ` +
        `discovery in this linter.`
    );

  const files = rels.map((rel) => ({
    rel,
    text: readFileSync(path.resolve(ROOT, rel), "utf8"),
  }));
  const { findings, references, allowed } = lintVaultSql({ files, tables });

  if (references === 0)
    fail(
      `scanned ${files.length} file(s) and matched zero vault table references. ` +
        `The SQL grammar or the registry reader is stale, not clean.`
    );

  // An allowance that has outlived its reason is how an allow-list rots.
  for (const [file, reason] of Object.entries(ALLOW_LIST)) {
    if (!existsSync(path.resolve(ROOT, file)))
      fail(`ALLOW_LIST names ${file}, which does not exist. Remove the entry.`);
    if (!allowed.has(file))
      fail(
        `ALLOW_LIST allows ${file} ("${reason}") but it no longer contains raw ` +
          `vault SQL. Delete the entry — a standing allowance nothing needs is ` +
          `a permission slip for the next file that moves in.`
      );
  }

  if (findings.length > 0) {
    console.error(
      `\nFAIL — ${findings.length} file(s) reach past the gateway:\n`
    );
    for (const finding of findings) {
      console.error(`  ${finding.file}:${finding.line} [${finding.rule}]`);
      console.error(`    ${finding.message}\n`);
    }
    process.exit(1);
  }

  console.log(
    `ok   vault-sql — ${references} table reference(s) across ${files.length} ` +
      `file(s); ${allowed.size} allow-listed file(s) still earn their entry, ` +
      `${tables.length} registry table(s) in the vocabulary`
  );
}

// Run as a CLI; stay importable (the pure functions) without side effects.
if (import.meta.url === `file://${process.argv[1]}`) main();
