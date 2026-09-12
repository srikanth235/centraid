// THE PHOTOS PARITY FIXTURE'S EMITTER AND ITS ORACLE, in one file (#1020, wave
// 4 lane Photos, D-1020-D3-6).
//
// This is the one permitted kind of edit to the pinned v0 tree: a fixture
// adapter under `packages/*/test/**` or `tests/**` that makes a v0 suite read
// `contracts/` files (#1020, Execution plan → Invariants). It adds no product
// code and changes no v0 behaviour.
//
// It lives under `tests/` for the reason Tally's adapter records:
// `packages/vault/tsconfig.test.json` sets `rootDir: "."`, so a file there
// cannot import both `contracts/tools/` and the blueprint handlers it invokes,
// and `tests/`'s own tsconfig already spans the repository. Nothing was
// relaxed to get here.
//
// TWO JOBS, ONE COMMAND. With `CENTRAID_WRITE_CONTRACTS=1` it WRITES the four
// files under `contracts/apps/photos/`; without it, it rebuilds the bundle
// from the live v0 tree and asserts equality with what is committed. So "the
// fixture passes in v0 too" is not a second suite that could rot — it is this
// test, and it fails the moment a v0 handler's answer moves.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  PHOTOS_PARITY_DIR,
  PHOTOS_PARITY_TABLES,
  buildPhotosParity,
  stableJson,
} from "../../contracts/tools/export-photos-parity.js";

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

describe("contracts/apps/photos", () => {
  it("is what the v0 handlers answer", async () => {
    const bundle = await buildPhotosParity();
    const payloads: Record<(typeof FILES)[number], string> = {
      "rows.json": stableJson(bundle.rows),
      "queries.json": stableJson(bundle.queries),
      "commands.json": stableJson(bundle.commands),
      "scenarios.json": stableJson(bundle.scenarios),
    };

    for (const file of FILES) {
      const target = path.join(ROOT, PHOTOS_PARITY_DIR, file);
      if (WRITE) {
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, payloads[file]);
      }
      // Read BACK, in both modes. A write run that asserts nothing is a run
      // that can emit an empty fixture and call it a pass.
      const committed = readFileSync(target, "utf8");
      // Parsed, not compared as text: the repository formatter owns JSON, so
      // the committed bytes are this emitter's output AFTER oxfmt. The VALUES
      // are what parity means.
      expect(
        JSON.parse(committed),
        `${file} is stale — regenerate it`
      ).toStrictEqual(JSON.parse(payloads[file]));
    }
  });

  it("compares a stated number of cases, so a silently empty run fails", () => {
    const read = (file: string): unknown =>
      JSON.parse(
        readFileSync(path.join(ROOT, PHOTOS_PARITY_DIR, file), "utf8")
      );
    const queries = read("queries.json") as { query: string }[];
    const commands = read("commands.json") as { command: string }[];
    const rows = read("rows.json") as { table: string; rows: unknown[] }[];
    // A fixture that generated nothing would pass every equality above. These
    // floors are what makes the suite mean something.
    expect(new Set(queries.map((entry) => entry.query)).size).toBe(8);
    expect(queries.length).toBeGreaterThanOrEqual(20);
    expect(commands.length).toBeGreaterThanOrEqual(20);
    expect(
      new Set(commands.map((entry) => entry.command)).size
    ).toBeGreaterThanOrEqual(15);
    // Every table the eight statements read is exported, and the roll is not
    // empty: `media_asset` is the one table a seeded library cannot lack.
    expect(rows.map((entry) => entry.table)).toStrictEqual([
      ...PHOTOS_PARITY_TABLES,
    ]);
    expect(
      rows.find((entry) => entry.table === "media_asset")?.rows.length
    ).toBeGreaterThanOrEqual(10);
    // The three ontology drifts a photograph is subject to. The generator
    // throws on a drift id that has moved, and this is the floor on the other
    // side of it: a scenarios file with two of the three is a fixture that
    // stopped carrying one.
    const scenarios = read("scenarios.json") as {
      scenarios: { drift: string }[];
    };
    expect(
      new Set(scenarios.scenarios.map((entry) => entry.drift))
    ).toStrictEqual(new Set(["ONT-22", "ONT-26", "ONT-28"]));
  });
});
