// THE DOCS PARITY FIXTURE'S EMITTER AND ITS ORACLE, in one file (#1020, wave 4
// slot 4b, D-1020-D3-6).
//
// This is the one permitted kind of edit to the pinned v0 tree: a fixture
// adapter under `packages/*/test/**` or `tests/**` that makes a v0 suite read
// `contracts/` files (#1020, Execution plan → Invariants). It adds no product
// code and changes no v0 behaviour.
//
// It lives under `tests/` for the reason Tally's and Photos' adapters record:
// `packages/vault/tsconfig.test.json` sets `rootDir: "."`, so a file there
// cannot import both `contracts/tools/` and the blueprint handlers it invokes,
// and `tests/`'s own tsconfig already spans the repository. Nothing was relaxed
// to get here.
//
// TWO JOBS, ONE COMMAND. With `CENTRAID_WRITE_CONTRACTS=1` it WRITES the four
// files under `contracts/apps/docs/`; without it, it rebuilds the bundle from
// the live v0 tree and asserts equality with what is committed. So "the fixture
// passes in v0 too" is not a second suite that could rot — it is this test, and
// it fails the moment a v0 handler's answer moves.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DOCS_PARITY_DIR,
  DOCS_PARITY_TABLES,
  buildDocsParity,
  stableJson,
} from "../../contracts/tools/export-docs-parity.js";

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
  JSON.parse(readFileSync(path.join(ROOT, DOCS_PARITY_DIR, file), "utf8"));

describe("contracts/apps/docs", () => {
  it("is what the v0 handlers answer", async () => {
    const bundle = await buildDocsParity();
    const payloads: Record<(typeof FILES)[number], string> = {
      "rows.json": stableJson(bundle.rows),
      "queries.json": stableJson(bundle.queries),
      "commands.json": stableJson(bundle.commands),
      "scenarios.json": stableJson(bundle.scenarios),
    };

    for (const file of FILES) {
      const target = path.join(ROOT, DOCS_PARITY_DIR, file);
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
      output: Record<string, unknown>;
    }[];
    const commands = read("commands.json") as {
      command: string;
      status: string;
    }[];
    const rows = read("rows.json") as { table: string; rows: unknown[] }[];
    // A fixture that generated nothing would pass every equality above. These
    // floors are what makes the suite mean something.
    expect(new Set(queries.map((entry) => entry.query))).toStrictEqual(
      new Set(["drive", "search", "history", "activity"])
    );
    expect(queries.length).toBeGreaterThanOrEqual(18);
    expect(commands.length).toBeGreaterThanOrEqual(30);
    // All sixteen of Docs' commands are in the script, and every one is a
    // `core.*` command — the fact the app's whole write surface is the core
    // schema's, as data rather than as a sentence.
    expect(new Set(commands.map((entry) => entry.command)).size).toBe(16);
    for (const entry of commands)
      expect(entry.command.startsWith("core.")).toBe(true);
    // AND THE REFUSALS ARE IN IT. A script of only happy paths cannot tell a
    // port that reproduces the gates from one that has none.
    expect(
      commands.filter((entry) => entry.status !== "executed").length
    ).toBeGreaterThanOrEqual(8);

    // Every table the four statements read is exported, and the drive is not
    // empty: `core_document` is the one table a seeded drive cannot lack.
    expect(rows.map((entry) => entry.table)).toStrictEqual([
      ...DOCS_PARITY_TABLES,
    ]);
    const rowsOf = (table: string): unknown[] =>
      rows.find((entry) => entry.table === table)?.rows ?? [];
    expect(rowsOf("core_document").length).toBeGreaterThanOrEqual(4);
    // THE SHARE PLANE IS POPULATED. An always-empty `shared_with` column is
    // exactly what a broken share fold looks like, so the corpus has to carry
    // answers for the comparison to mean anything.
    expect(rowsOf("share_authority").length).toBeGreaterThanOrEqual(3);
    expect(rowsOf("share_fulfillment").length).toBeGreaterThanOrEqual(3);
    expect(rowsOf("share_subscription_lineage").length).toBeGreaterThanOrEqual(
      1
    );
    // AND A NESTED FOLDER IS IN IT, because a corpus of flat folders cannot
    // tell a working chain from a chain of length one — which is the v0 defect
    // this lane fixed at source (R-1020-35).
    const concepts = rows.find((entry) => entry.table === "core_concept");
    const parentAt = (concepts?.rows as unknown[][] | undefined)?.some(
      (row) =>
        row[
          (
            (read("rows.json") as { table: string; columns: string[] }[]).find(
              (entry) => entry.table === "core_concept"
            )?.columns ?? []
          ).indexOf("broader_concept_id")
        ] !== null
    );
    expect(parentAt, "no folder has a parent: the chain proves nothing").toBe(
      true
    );

    // THE DRIVE'S CLAMP, as cases. Three windows and the two that are clamped.
    const windows = queries
      .filter((entry) => entry.query === "drive")
      .map((entry) => entry.output.window);
    expect(windows).toStrictEqual([200, 20, 2000, 20, 2000]);
    // EVERY CASE RUNS UNDER THE OWNER'S OWN CREDENTIAL, so `vaultDenied` must
    // be absent everywhere — with ONE exception the fixture states rather than
    // hides.
    //
    // **`activity` is refused for every caller, the owner included** (#1020,
    // finding 2: the activity rail has never answered an event through the
    // gateway's paged door). `docs.activity.provenance` reads
    // `access_provenance`, and the door's resolver serves only tables registered
    // as ENTITIES — `access_provenance` declares no
    // `FOREIGN KEY (prov_id) REFERENCES core_entity(entity_id)`, so it is not
    // one and the plan is refused at `paged-door.ts:436` before any access
    // decision is taken. The manifest declares the scope, the handler ships, the
    // rows are there, and the trail is empty on every surface for a reason no
    // consent screen can fix.
    //
    // Partitioned rather than branched inside a loop, so every assertion below
    // runs unconditionally: a conditional `expect` is an assertion that can quietly
    // stop happening.
    const activity = queries.filter((entry) => entry.query === "activity");
    const rest = queries.filter((entry) => entry.query !== "activity");
    expect(activity.length).toBeGreaterThanOrEqual(4);
    // Asserted EXACTLY, so the day the door admits the audit band this test
    // fails and the fixture is regenerated rather than quietly carrying a denial
    // nobody reads.
    expect(
      activity.map(
        (entry) =>
          (entry.output.vaultDenied as { message?: string } | undefined)
            ?.message
      ),
      "the activity refusal moved: regenerate and re-judge finding 2"
    ).toStrictEqual(
      activity.map(
        () =>
          'paged door refuses handler "docs.activity.provenance": FROM names ' +
          "access_provenance, which is not an entity of this vault"
      )
    );
    expect(activity.map((entry) => entry.output.events)).toStrictEqual(
      activity.map(() => [])
    );
    expect(
      rest.map((entry) => [entry.query, entry.output.vaultDenied])
    ).toStrictEqual(rest.map((entry) => [entry.query, undefined]));
  });
});
