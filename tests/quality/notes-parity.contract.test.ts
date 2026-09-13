// THE NOTES PARITY FIXTURE'S EMITTER AND ITS ORACLE, in one file (#1020, wave 4
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
// files under `contracts/apps/notes/`; without it, it rebuilds the bundle from
// the live v0 tree and asserts equality with what is committed. So "the fixture
// passes in v0 too" is not a second suite that could rot — it is this test, and
// it fails the moment a v0 handler's answer moves.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  NOTES_PARITY_DIR,
  NOTES_PARITY_TABLES,
  buildNotesParity,
  stableJson,
} from "../../contracts/tools/export-notes-parity.js";

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
  JSON.parse(readFileSync(path.join(ROOT, NOTES_PARITY_DIR, file), "utf8"));

describe("contracts/apps/notes", () => {
  it("is what the v0 handlers answer", async () => {
    const bundle = await buildNotesParity();
    const payloads: Record<(typeof FILES)[number], string> = {
      "rows.json": stableJson(bundle.rows),
      "queries.json": stableJson(bundle.queries),
      "commands.json": stableJson(bundle.commands),
      "scenarios.json": stableJson(bundle.scenarios),
    };

    for (const file of FILES) {
      const target = path.join(ROOT, NOTES_PARITY_DIR, file);
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
      pending?: string;
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
        "library",
        "note",
        "search",
        "history",
        "journal",
        "link-targets",
      ])
    );
    expect(queries.length).toBeGreaterThanOrEqual(30);
    expect(commands.length).toBeGreaterThanOrEqual(35);
    // NOTES REACHES THREE SCHEMAS, and the script proves it as data rather than
    // as a sentence: nine `knowledge.*`, the five `core.*` link and attachment
    // commands plus the two tag ones, and the one `schedule.*` it owes another
    // lane.
    const schemas = new Set(
      commands.map((entry) => entry.command.split(".")[0])
    );
    expect(schemas).toStrictEqual(new Set(["knowledge", "core", "schedule"]));
    const knowledge = new Set(
      commands
        .map((entry) => entry.command)
        .filter((name) => name.startsWith("knowledge."))
    );
    expect(
      knowledge.size,
      "all nine knowledge commands are in the script"
    ).toBe(9);
    // AND THE REFUSALS ARE IN IT. A script of only happy paths cannot tell a
    // port that reproduces the gates from one that has none.
    expect(
      commands.filter((entry) => entry.status !== "executed").length
    ).toBeGreaterThanOrEqual(12);
    // NO STEP IS PENDING ANY MORE. `schedule.add_task` was the only one and
    // slot 4d registered the schema, so `send-to-tasks`' own command EXECUTES
    // here — which is what the mark was waiting for.
    const pending = commands.filter((entry) => entry.pending !== undefined);
    expect(
      pending.map((entry) => [entry.command, entry.pending])
    ).toStrictEqual([]);
    const sendToTasks = commands.find(
      (entry) => entry.command === "schedule.add_task"
    );
    expect(sendToTasks?.status).toBe("executed");

    // Every table the six statements read is exported, and the library is not
    // empty: `knowledge_note` is the one table a seeded library cannot lack.
    expect(rows.map((entry) => entry.table)).toStrictEqual([
      ...NOTES_PARITY_TABLES,
    ]);
    const rowsOf = (table: string): unknown[] =>
      rows.find((entry) => entry.table === table)?.rows ?? [];
    expect(rowsOf("knowledge_note").length).toBeGreaterThanOrEqual(6);
    expect(rowsOf("core_collection").length).toBeGreaterThanOrEqual(3);
    // THE DECORATION TABLES ARE POPULATED. An always-empty `references` or
    // `attachments` column is exactly what a broken fold looks like, so the
    // corpus has to carry rows for the comparison to mean anything.
    expect(rowsOf("core_link").length).toBeGreaterThanOrEqual(2);
    expect(rowsOf("core_link_anchor").length).toBeGreaterThanOrEqual(1);
    expect(rowsOf("core_attachment").length).toBeGreaterThanOrEqual(1);
    expect(rowsOf("core_tag").length).toBeGreaterThanOrEqual(2);
    // MORE THAN ONE OCCURRENCE ON ONE NOTE, or the version chain proves nothing.
    expect(rowsOf("core_entity_revision").length).toBeGreaterThanOrEqual(8);
    // THE JOURNAL MARKER IS IN THE CORPUS. Without it every exclusion below is
    // vacuous, and a vacuous exclusion is what a broken one looks like.
    const conceptColumns =
      rows.find((entry) => entry.table === "core_concept_scheme")?.columns ??
      [];
    const uriAt = conceptColumns.indexOf("uri");
    expect(
      (rowsOf("core_concept_scheme") as unknown[][]).some(
        (row) => row[uriAt] === "https://centraid.dev/schemes/people-journal"
      ),
      "no journal scheme: every exclusion case is vacuous"
    ).toBe(true);
  });

  it("holds the library asymmetry as a comparison, not as a claim", () => {
    const queries = read("queries.json") as {
      query: string;
      input: Record<string, unknown>;
      output: Record<string, unknown>;
    }[];
    const journal = queries.find((entry) => entry.query === "journal");
    const entries = (journal?.output.entries ?? []) as { note_id: string }[];
    // The Journal place has an entry. Without one, every exclusion asserted
    // below is vacuous.
    expect(entries).toHaveLength(1);
    const journalId = entries[0]?.note_id;

    // ABSENT FROM THE LIBRARY, the trash shelf and the powerbox…
    for (const entry of queries.filter((case_) => case_.query === "library")) {
      const shelves = [
        ...((entry.output.notes ?? []) as { note_id: string }[]),
        ...((entry.output.trash ?? []) as { note_id: string }[]),
      ];
      expect(shelves.map((row) => row.note_id)).not.toContain(journalId);
    }
    for (const entry of queries.filter(
      (case_) => case_.query === "link-targets"
    )) {
      const targets = (entry.output.targets ?? []) as { id: string }[];
      expect(targets.map((target) => target.id)).not.toContain(journalId);
    }
    // …AND REACHABLE BY ID. This is the pair that makes it an asymmetry rather
    // than a bug, and a port that unified the two breaks exactly one of them.
    const byId = queries.find(
      (entry) => entry.query === "note" && entry.input.note_id === journalId
    );
    expect(byId, "the journal entry has a `note` case").toBeDefined();
    expect(
      (byId?.output.body as string | undefined)?.length ?? 0
    ).toBeGreaterThan(0);
  });

  it("carries the clamp, the shelves and the denials as values", () => {
    const queries = read("queries.json") as {
      query: string;
      output: Record<string, unknown>;
    }[];
    // THE LIBRARY'S CLAMP, as cases. Three windows and the two that are clamped.
    const windows = queries
      .filter((entry) => entry.query === "library")
      .map((entry) => entry.output.window);
    expect(windows).toStrictEqual([200, 20, 2000, 20, 2000]);
    const journalWindows = queries
      .filter((entry) => entry.query === "journal")
      .map((entry) => entry.output.window);
    expect(journalWindows).toStrictEqual([200, 20]);
    // A PIN LEADS THE SHELF. The script pins one note, so every library case
    // has to answer it first — which is the fold's own ordering, compared
    // rather than asserted about.
    for (const entry of queries.filter((case_) => case_.query === "library")) {
      const notes = (entry.output.notes ?? []) as { pinned?: number }[];
      expect(notes.length).toBeGreaterThan(0);
      expect(notes[0]?.pinned).toBe(1);
    }
    // EVERY CASE RUNS UNDER THE OWNER'S OWN CREDENTIAL, so `vaultDenied` is
    // absent everywhere. Notes has no `activity`-shaped surface: all six of its
    // queries read tables the paged door serves.
    expect(
      queries.map((entry) => [entry.query, entry.output.vaultDenied])
    ).toStrictEqual(queries.map((entry) => [entry.query, undefined]));
  });
});
