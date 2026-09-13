// THE CIVIL-TIME CORPUS' EMITTER AND ITS ORACLE, in one file (#1020, wave 4
// lane Schedule, D-1020-D3-6).
//
// This is the one permitted kind of edit to the pinned v0 tree: a fixture
// adapter under `tests/**` that makes a v0 suite read `contracts/` files
// (#1020, Execution plan → Invariants). It adds no product code and changes
// no v0 behaviour.
//
// It lives under `tests/` for the reason every other adapter records:
// `packages/*/tsconfig.test.json` sets `rootDir: "."`, so a file there cannot
// import both `contracts/tools/` and the v0 modules it invokes, and `tests/`'s
// own tsconfig already spans the repository.
//
// TWO JOBS, ONE COMMAND. With `CENTRAID_WRITE_CONTRACTS=1` it WRITES the three
// files under `contracts/time/`; without it, it rebuilds the corpus from the
// live v0 tree and asserts equality with what is committed:
//
//     CENTRAID_WRITE_CONTRACTS=1 node node_modules/vitest/vitest.mjs run \
//       tests/quality/time-corpus.contract.test.ts
//     bun run format && git diff --exit-code contracts/time

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  TIME_CORPUS_DIR,
  TIME_CORPUS_FILES,
  buildTimeCorpus,
  payloadsFor,
} from "../../contracts/tools/export-time-corpus.js";

const ROOT = path.join(import.meta.dirname, "..", "..");
const WRITE = process.env.CENTRAID_WRITE_CONTRACTS === "1";

describe("contracts/time", () => {
  it("is what the v0 time modules answer", async () => {
    const corpus = await buildTimeCorpus();
    const payloads = payloadsFor(corpus);
    for (const file of TIME_CORPUS_FILES) {
      const target = path.join(ROOT, TIME_CORPUS_DIR, file);
      if (WRITE) {
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, payloads[file]);
        continue;
      }
      const committed: unknown = JSON.parse(readFileSync(target, "utf8"));
      expect(
        JSON.parse(payloads[file]),
        `${TIME_CORPUS_DIR}/${file} is stale — re-run with CENTRAID_WRITE_CONTRACTS=1`
      ).toStrictEqual(committed);
    }
  });

  // The corpus' own shape, asserted so a silently empty bundle cannot pass the
  // equality check above by being equally empty on both sides.
  it("covers the accepted subset, every refused part and five adversarial zones", async () => {
    const corpus = await buildTimeCorpus();
    const accepted = corpus.rruleCases.cases.filter((entry) => entry.accepted);
    const refused = corpus.rruleCases.cases.filter((entry) => !entry.accepted);
    expect(accepted.length).toBeGreaterThan(80);
    expect(refused.length).toBeGreaterThan(30);
    // Every refused part appears with its own sentence, and no two parts
    // share one.
    const parts = new Set(
      refused.map((entry) => entry.part).filter((part) => part !== undefined)
    );
    expect([...parts].sort()).toStrictEqual([
      "BYDAY",
      "BYHOUR",
      "BYMINUTE",
      "BYMONTH",
      "BYMONTHDAY",
      "BYSECOND",
      "BYSETPOS",
      "BYWEEKNO",
      "BYYEARDAY",
      "WKST",
    ]);
    expect(new Set(refused.map((entry) => entry.message)).size).toBe(
      new Set(
        refused.map(
          (entry) => `${entry.reason}:${entry.part ?? entry.freq ?? ""}`
        )
      ).size
    );
    // The cautionary case, by name.
    expect(corpus.rruleCases.cautionary.accepted).toBe(false);
    expect(corpus.rruleCases.cautionary.part).toBe("BYSETPOS");
    expect(corpus.rruleCases.cautionary.summary).toBeNull();

    // A refused rule expands to NOTHING, in every zone.
    const refusedExpansions = corpus.dstCases.cases.filter(
      (entry) => entry.rrule === "FREQ=MONTHLY;BYSETPOS=-1"
    );
    expect(refusedExpansions.length).toBe(6);
    expect(
      refusedExpansions.every((entry) => entry.occurrences.length === 0)
    ).toBe(true);

    expect(new Set(corpus.dstCases.cases.map((entry) => entry.zone)).size).toBe(
      6
    );
    // A gap resolves to nothing and a fold resolves once, and both happen.
    const gaps = corpus.dstCases.wallResolutions.filter(
      (entry) => entry.instant === null
    );
    const folds = corpus.dstCases.wallResolutions.filter(
      (entry) => entry.overlap === true
    );
    expect(gaps.length).toBeGreaterThan(0);
    expect(folds.length).toBeGreaterThan(0);
  });

  // THE OCCURRENCE KEY, held as a test rather than a paragraph: the same skip
  // keyed on the resolved instant matches nothing at all.
  it("proves the occurrence key is the wall clock, never the instant", async () => {
    const corpus = await buildTimeCorpus();
    const cases = corpus.occurrenceCases as {
      column: string;
      ont25: {
        keptWithInstantKey: number;
        keptWithWallKey: number;
        total: number;
      };
      exceptions: { localStart: string }[];
    };
    expect(cases.column).toBe("original_start_local");
    expect(cases.ont25.keptWithInstantKey).toBe(cases.ont25.total);
    expect(cases.ont25.keptWithWallKey).toBeLessThan(cases.ont25.total);
    // The unkeyed row and the two foreign-series rows never reach the fold.
    expect(cases.exceptions).toHaveLength(4);
  });
});
