// THE PEOPLE PARITY FIXTURE'S EMITTER AND ITS ORACLE, in one file (#1020, wave 4
// slot 4c, D-1020-D3-6).
//
// This is the one permitted kind of edit to the pinned v0 tree: a fixture
// adapter under `packages/*/test/**` or `tests/**` that makes a v0 suite read
// `contracts/` files (#1020, Execution plan → Invariants). It adds no product
// code and changes no v0 behaviour.
//
// It lives under `tests/` for the reason Tally's, Photos' and Docs' adapters
// record: `packages/vault/tsconfig.test.json` sets `rootDir: "."`, so a file
// there cannot import both `contracts/tools/` and the blueprint handlers it
// invokes, and `tests/`'s own tsconfig already spans the repository. Nothing was
// relaxed to get here.
//
// TWO JOBS, ONE COMMAND. With `CENTRAID_WRITE_CONTRACTS=1` it WRITES the four
// files under `contracts/apps/people/`; without it, it rebuilds the bundle from
// the live v0 tree and asserts equality with what is committed. So "the fixture
// passes in v0 too" is not a second suite that could rot — it is this test, and
// it fails the moment a v0 handler's answer moves.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  PEOPLE_PARITY_DIR,
  PEOPLE_PARITY_TABLES,
  buildPeopleParity,
  stableJson,
} from "../../contracts/tools/export-people-parity.js";

/** The repository root, from this file's own location. */
const ROOT = path.join(import.meta.dirname, "..", "..");

const WRITE = process.env.CENTRAID_WRITE_CONTRACTS === "1";

/** The four files, and the slice of the bundle each one carries. */
const FILES = [
  "rows.json",
  "queries.json",
  "commands.json",
  "scenarios.json",
] as const;

const read = (file: string): unknown =>
  JSON.parse(readFileSync(path.join(ROOT, PEOPLE_PARITY_DIR, file), "utf8"));

describe("contracts/apps/people", () => {
  it("is what the v0 handlers answer", async () => {
    const bundle = await buildPeopleParity();
    const payloads: Record<(typeof FILES)[number], string> = {
      "rows.json": stableJson(bundle.rows),
      "queries.json": stableJson(bundle.queries),
      "commands.json": stableJson(bundle.commands),
      "scenarios.json": stableJson(bundle.scenarios),
    };

    for (const file of FILES) {
      const target = path.join(ROOT, PEOPLE_PARITY_DIR, file);
      if (WRITE) {
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, payloads[file]);
      }
      // Read BACK, in both modes. A write run that asserts nothing is a run
      // that can emit an empty fixture and call it a pass.
      const committed = readFileSync(target, "utf8");
      // Parsed, not compared as text: the repository formatter owns JSON, so the
      // committed bytes are this emitter's output AFTER oxfmt. The VALUES are
      // what parity means.
      expect(
        JSON.parse(committed),
        `${file} is stale — regenerate it`
      ).toStrictEqual(JSON.parse(payloads[file]));
    }
  });

  it("compares a stated number of cases, so a silently empty run fails", () => {
    const queries = read("queries.json") as {
      query: string;
      input: Record<string, unknown>;
      output: Record<string, unknown>;
    }[];
    const commands = read("commands.json") as {
      command: string;
      status: string;
    }[];
    const rows = read("rows.json") as {
      table: string;
      columns: string[];
      rows: unknown[];
    }[];

    // A fixture that generated nothing would pass every equality above. These
    // floors are what makes the suite mean something.
    expect(new Set(queries.map((entry) => entry.query))).toStrictEqual(
      new Set([
        "people",
        "person",
        "dashboard",
        "journal",
        "search",
        "trash",
        "history",
      ])
    );
    expect(queries.length).toBeGreaterThanOrEqual(25);

    // EVERY COMMAND OF BOTH SCHEMAS IS IN THE SCRIPT, plus the one `core.*`
    // primitive `merge-people` invokes — thirty-three distinct commands, which
    // is the largest write surface of any bundled app as data rather than as a
    // sentence.
    const invoked = new Set(commands.map((entry) => entry.command));
    expect(
      [...invoked].filter((name) => name.startsWith("people."))
    ).toHaveLength(28);
    expect(
      [...invoked].filter((name) => name.startsWith("social."))
    ).toHaveLength(4);
    expect(invoked.has("core.merge_party")).toBe(true);
    expect(invoked.size).toBe(33);
    expect(commands.length).toBeGreaterThanOrEqual(60);
    // AND THE REFUSALS ARE IN IT. A script of only happy paths cannot tell a
    // port that reproduces the gates from one that has none.
    expect(
      commands.filter((entry) => entry.status !== "executed").length
    ).toBeGreaterThanOrEqual(12);

    // Every table the seven handlers read is exported, and the roster is not
    // empty: `people_profile` is the one table a seeded roster cannot lack.
    expect(rows.map((entry) => entry.table)).toStrictEqual([
      ...PEOPLE_PARITY_TABLES,
    ]);
    const rowsOf = (table: string): unknown[] =>
      rows.find((entry) => entry.table === table)?.rows ?? [];
    expect(rowsOf("people_profile").length).toBeGreaterThanOrEqual(4);
    // THE SHARING PLANE IS POPULATED. An always-false `linked` column is
    // exactly what a broken sharing read looks like, so the corpus has to carry
    // bindings for the comparison to mean anything — including one REVOKED, so
    // the read's own filter is exercised rather than the fold's.
    const bindings = rows.find(
      (entry) => entry.table === "share_party_vault_binding"
    );
    expect(bindings?.rows.length).toBeGreaterThanOrEqual(4);
    const revokedAt = (bindings?.columns ?? []).indexOf("revoked_at");
    expect(
      (bindings?.rows as unknown[][] | undefined)?.some(
        (row) => row[revokedAt] !== null
      ),
      "no binding is revoked: the read's own filter proves nothing"
    ).toBe(true);
    // AND THE CROSS-APP TABLE IS NOT EMPTY: `tally_obligation` is Tally's, read
    // by People, and an empty one would make the debts rail untestable.
    expect(rowsOf("tally_obligation").length).toBeGreaterThanOrEqual(2);
    // A MERGE HAPPENED, so the merged party is gone from `core_party` and its
    // note moved. `repointed` is the tally the fixture records.
    const merges = commands.filter(
      (entry) => entry.command === "core.merge_party"
    );
    expect(merges).toHaveLength(3);
    expect(merges.filter((entry) => entry.status === "executed")).toHaveLength(
      1
    );

    // THE ROSTER'S WINDOW, as cases — and the divergence D-1020-PE4 names.
    // v0 clamps to 9,999, so a caller asking for the schema's own maximum of
    // 10,000 is told `window: 9999`. The fixture records v0's answer; the Rust
    // side maps it and the receipt carries the finding.
    const windows = queries
      .filter((entry) => entry.query === "people")
      .map((entry) => entry.output.window);
    expect(windows).toStrictEqual([9999, 20, 9999, 9999, 20, 9999]);

    // EVERY CASE RUNS UNDER THE OWNER'S OWN CREDENTIAL, so `vaultDenied` must
    // be absent everywhere. People's three-state readings are about a REVOKED
    // scope, which this corpus does not have; the Rust side proves them with a
    // door that refuses (`crates/apps/people/tests/three_state.rs`).
    expect(
      queries.map((entry) => [entry.query, entry.output.vaultDenied])
    ).toStrictEqual(queries.map((entry) => [entry.query, undefined]));

    // AND `links_available` IS TRUE ON EVERY ROSTER CASE, which is what makes
    // `linked` readable at all.
    expect(
      queries
        .filter((entry) => entry.query === "people")
        .map((entry) => entry.output.links_available)
    ).toStrictEqual(
      queries.filter((entry) => entry.query === "people").map(() => true)
    );
  });
});
