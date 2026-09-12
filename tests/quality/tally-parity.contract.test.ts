// THE TALLY PARITY FIXTURE'S EMITTER AND ITS ORACLE, in one file (#1020, wave
// 2 lane D3).
//
// This is the one permitted kind of edit to the pinned v0 tree: a fixture
// adapter under `packages/*/test/**` or `tests/**` that makes a v0 suite read
// `contracts/` files (#1020, Execution plan → Invariants). It adds no product
// code and changes no v0 behaviour.
//
// WHY IT LIVES UNDER `tests/` AND NOT `packages/vault/tests/`.
// `packages/vault/tsconfig.test.json` sets `rootDir: "."`, so a file there
// cannot import anything outside the package — and this adapter has to import
// both `contracts/tools/` and the blueprint handlers it invokes. `tests/`'s own
// tsconfig has no `rootDir` and already spans the repository, which is what
// makes it the home the invariants name for exactly this shape of file. Nothing
// was relaxed to get here.
//
// TWO JOBS, ONE COMMAND. With `CENTRAID_WRITE_CONTRACTS=1` it WRITES the four
// files under `contracts/apps/tally/`; without it, it rebuilds the bundle from
// the live v0 tree and asserts BYTE-equality with what is committed. So "the
// fixture passes in v0 too" is not a second suite that could rot — it is this
// test, and it fails the moment a v0 handler's answer moves.
//
// The shape is v0's own precedent: one emitter, N committed generated
// artifacts, one lint that fails on drift (`scripts/site-tokens.mjs`, ruled at
// docs/decisions.md:411).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  TALLY_PARITY_DIR,
  buildTallyParity,
  stableJson,
} from "../../contracts/tools/export-tally-parity.js";

/** The repository root, from this file's own location. */
const ROOT = path.join(import.meta.dirname, "..", "..");

const WRITE = process.env.CENTRAID_WRITE_CONTRACTS === "1";

/** The four files, and the slice of the bundle each one carries. */
const FILES = [
  "rows.json",
  "queries.json",
  "balances.json",
  "scenarios.json",
] as const;

describe("contracts/apps/tally", () => {
  it("is what the v0 handlers answer", async () => {
    const bundle = await buildTallyParity();
    const payloads: Record<(typeof FILES)[number], string> = {
      "rows.json": stableJson(bundle.rows),
      "queries.json": stableJson(bundle.queries),
      "balances.json": stableJson(bundle.balances),
      "scenarios.json": stableJson(bundle.scenarios),
    };

    for (const file of FILES) {
      const target = path.join(ROOT, TALLY_PARITY_DIR, file);
      if (WRITE) {
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, payloads[file]);
      }
      // Read BACK, in both modes. A write run that asserts nothing is a run
      // that can emit an empty fixture and call it a pass — and this suite's
      // config requires an assertion per test for exactly that reason.
      const committed = readFileSync(target, "utf8");
      // Parsed, not compared as text: the repository formatter owns JSON, so
      // the committed bytes are this emitter's output AFTER oxfmt and the
      // whitespace is oxfmt's to choose. The VALUES are what parity means.
      expect(
        JSON.parse(committed),
        `${file} is stale — regenerate it`
      ).toStrictEqual(JSON.parse(payloads[file]));
    }
  });

  it("compares a stated number of cases, so a silently empty run fails", () => {
    const queries = JSON.parse(
      readFileSync(path.join(ROOT, TALLY_PARITY_DIR, "queries.json"), "utf8")
    ) as { query: string }[];
    const balances = JSON.parse(
      readFileSync(path.join(ROOT, TALLY_PARITY_DIR, "balances.json"), "utf8")
    ) as unknown[];
    // A fixture that generated nothing would pass every equality above. These
    // two floors are what makes the suite mean something.
    expect(queries.length).toBeGreaterThanOrEqual(20);
    expect(balances.length).toBeGreaterThanOrEqual(6);
    expect(new Set(queries.map((entry) => entry.query)).size).toBe(8);
  });
});
