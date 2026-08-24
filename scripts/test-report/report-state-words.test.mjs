import { writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  baseMatrix,
  CAPTURED_AT,
  CAPTURED_MS,
  FRESH_WINDOW_HOURS,
  makeFixtureRoot,
  runGenerate,
  writeJson,
} from "./report-fixture-root.mjs";

/**
 * A matrix cell says its state in WORDS (#862): `<button class="cell failed
 * …">failed</button>`, with the family tint behind the word as the second
 * reading rather than the only one.
 *
 * `report-theme.test.mjs` proves the twelve states keep pairwise-distinct CSS
 * treatments — and that two pairs deliberately COLLAPSE onto one treatment:
 * `failed` ≡ `infra-mismatch`, and `stale` ≡ `lane-did-not-run`. Each of those
 * pairs is told apart by its word and by nothing else. That collapse is only
 * honest while the word is actually on the page.
 *
 * Nothing asserted that until this file. A cell rendered empty, or rendered
 * carrying the wrong state's word, passes every other gate standing: the sheet
 * still resolves, the classes are still distinct, the page still loads — while
 * a failure and an infra mismatch become one indistinguishable tone and the
 * report quietly stops answering the question it exists to answer. So the words
 * are pinned here at the byte level, off a real render of a real page.
 */

/**
 * The word each state owes, transcribed from `generate.mjs#stateWord`.
 * `generate.mjs` is a side-effecting main with no exported seam, so this table
 * cannot import the mapping — which is the point: it is an independent
 * statement of the contract, and the render below is what proves the generator
 * still agrees with it.
 */
const STATE_WORDS = {
  passed: "passed",
  failed: "failed",
  flaky: "flaky",
  skipped: "n/a",
  gap: "gap",
  "evidence-unmatched": "unmatched",
  "owner-silent": "silent",
  missing: "missing",
  stale: "stale",
  "lane-did-not-run": "no lane",
  "expected-grey": "named",
  "infra-mismatch": "infra",
};

/** The pairs `report-theme.test.mjs` allows to share one CSS treatment. */
const COLLAPSED_PAIRS = [
  ["failed", "infra-mismatch"],
  ["stale", "lane-did-not-run"],
];

/**
 * One surface whose twelve dimensions each land in a different cell state.
 * Every state below is reached the way the nightly reaches it, never by
 * writing a state into the fixture: the matrix declares owners and
 * assessments, and `buildCells` derives the state from the evidence.
 */
function statesMatrix() {
  const owned = (owner, tier = "unit") => ({ owner, tier });
  return {
    ...baseMatrix(),
    notes: {
      "vault.skipped": "deliberate skip note",
      "vault.gap": "no owner yet",
    },
    dimensions: [
      // `silent` rides the perf tier so its expected lane marker is `perf`,
      // which the fixture writes; every other owner expects `vitest`, which it
      // does not — that difference is what separates owner-silent from
      // lane-did-not-run.
      ["silent", "perf"],
      ["passed", "unit"],
      ["failed", "unit"],
      ["flaky", "unit"],
      ["infra", "unit"],
      ["skipped", "unit"],
      ["gap", "unit"],
      ["stale", "unit"],
      ["missing", "unit"],
      ["nolane", "unit"],
      ["collide", "unit"],
      ["named", "unit"],
    ].map(([id, lane]) => ({ id, label: id, lane })),
    surfaces: [
      {
        id: "vault",
        label: "Vault",
        assessment: {
          silent: "solid",
          passed: "solid",
          failed: "solid",
          flaky: "solid",
          infra: "solid",
          skipped: "skip",
          gap: "gap",
          stale: "solid",
          missing: "partial",
          nolane: "solid",
          collide: "solid",
          named: "solid",
        },
      },
    ],
    cellOwners: {
      "vault.silent": owned("owners/perf-owner.mjs", "perf"),
      "vault.passed": owned("owners/passed.mjs"),
      "vault.failed": owned("owners/failed.mjs"),
      "vault.flaky": owned("owners/flaky.mjs"),
      "vault.infra": owned("owners/infra.mjs"),
      "vault.skipped": null,
      "vault.gap": null,
      // Declared but deleted: `validate-matrix.mjs` reports "owner does not
      // exist" and `buildCells` reads that back as a stale owner. Staleness by
      // deletion rather than by age keeps the fixture off the wall clock.
      "vault.stale": owned("owners/deleted-owner.mjs"),
      "vault.missing": null,
      "vault.nolane": owned("owners/nolane.mjs"),
      "vault.collide": owned("owners/collide.mjs"),
      "vault.named": owned("owners/named.mjs"),
    },
  };
}

/** Render the twelve-state page and return the generator result. */
function renderStates() {
  const root = makeFixtureRoot({ matrix: statesMatrix() });
  for (const name of [
    "perf-owner",
    "passed",
    "failed",
    "flaky",
    "infra",
    "nolane",
    "collide",
    "named",
  ]) {
    writeFileSync(
      path.join(root, "owners", `${name}.mjs`),
      "test('owned behaviour', () => {});\n"
    );
  }
  // `expected-grey` needs a named absence, and the real register is empty by
  // design (#791 retired the last one). The synthetic root therefore carries a
  // fixture register beside the generator it copies, the same way it carries
  // fixture coverage and mutation floors — `expected-grey.mjs` is a data
  // module, and this is its datum.
  writeFileSync(
    path.join(root, "scripts/test-report/expected-grey.mjs"),
    `export const EXPECTED_GREY = ${JSON.stringify(
      [
        {
          lane: "fixture-lane",
          cells: ["vault:named"],
          issue: "839",
          reason: "a fixture absence, so the twelfth state has a cell",
          owner: "owners/named.mjs",
        },
      ],
      null,
      2
    )};\n`
  );
  const vitestPath = writeJson(root, "in/vitest.json", {
    startTime: CAPTURED_MS,
    testResults: [
      ["owners/passed.mjs", "passed"],
      ["owners/failed.mjs", "failed"],
      ["owners/flaky.mjs", "flaky"],
      ["owners/infra.mjs", "infra-mismatch"],
      // A DIFFERENT file whose basename collides with `owners/collide.mjs`:
      // that collision is what makes the declared owner's silence unmatchable
      // rather than merely absent.
      ["other/collide.mjs", "passed"],
    ].map(([name, status]) => ({
      name,
      status,
      startTime: CAPTURED_MS,
      endTime: CAPTURED_MS,
      assertionResults: [],
    })),
  });
  writeJson(root, "markers/lane-starts.json", { perf: CAPTURED_AT });
  // Nightly scope: the three no-evidence states (`owner-silent`,
  // `lane-did-not-run`, `evidence-unmatched`) only exist under it, and the run
  // exits non-zero on the zero-grey contract by construction — this page is a
  // red night, on purpose. The HTML is written either way.
  return runGenerate(root, [
    "--scope",
    "nightly",
    "--vitest",
    vitestPath,
    "--lane-markers",
    path.join(root, "markers"),
    "--max-age-hours",
    FRESH_WINDOW_HOURS,
  ]);
}

/** Matrix cells only: the app-axis grids speak a different alphabet. */
function matrixCells(html) {
  return [
    ...html.matchAll(
      /<button class="cell (?<state>[a-z-]+) assessment-[a-z-]+"(?<attrs>[^>]*)>(?<word>[^<]*)</gu
    ),
  ].map((hit) => ({
    attrs: hit.groups?.attrs ?? "",
    state: hit.groups?.state ?? "",
    word: hit.groups?.word ?? "",
  }));
}

let rendered;
/** One render, reused: the fixture is deterministic and the run is a subprocess. */
function statesPage() {
  rendered ??= matrixCells(renderStates().html);
  return rendered;
}

describe("the word a matrix cell says", () => {
  test("every one of the twelve states renders, and says its own word", () => {
    const cells = statesPage();
    // Twelve dimensions, one surface: a dropped cell is as dishonest as a
    // wordless one, so the count is pinned alongside the words.
    expect(cells).toHaveLength(12);
    const seen = new Map(cells.map((cell) => [cell.state, cell.word]));
    expect([...seen.keys()].sort()).toEqual(Object.keys(STATE_WORDS).sort());
    for (const [state, word] of seen) {
      expect(word, `.cell.${state} rendered no word`).not.toBe("");
      expect(word, `.cell.${state} says the wrong word`).toBe(
        STATE_WORDS[state]
      );
    }
  });

  test("names the same word to a screen reader as to the eye", () => {
    // The accessible name carries the word AND the raw state — `failed
    // (failed)`, `infra (infra-mismatch)`. Pinning the pair here is what stops
    // the label and the text drifting apart, which would leave one of the two
    // audiences reading a state the other cannot see.
    for (const cell of statesPage()) {
      expect(cell.word, `.cell.${cell.state} rendered no word`).not.toBe("");
      expect(cell.attrs).toContain(`: ${cell.word} (${cell.state});`);
    }
  });

  test("tells the two collapsed pairs apart by word alone", () => {
    // This is the trade `report-theme.test.mjs` records: `failed` and
    // `infra-mismatch` share one tone, `stale` and `lane-did-not-run` share
    // another, and the page stays honest only because the words differ. If a
    // pair ever converged on one word the two states would be indistinguishable
    // in both readings at once — no tint to separate them, no text either.
    const seen = new Map(statesPage().map((cell) => [cell.state, cell.word]));
    for (const [left, right] of COLLAPSED_PAIRS) {
      expect(seen.get(left)).toBeTruthy();
      expect(seen.get(right)).toBeTruthy();
      expect(
        seen.get(right),
        `${left} and ${right} share a treatment AND a word`
      ).not.toBe(seen.get(left));
    }
  });

  test("gives all twelve states a word of their own", () => {
    // Distinctness across the whole alphabet, not just the collapsed pairs: two
    // states sharing a word is the same silence as a state having none, and the
    // register is only readable while each of the twelve is separable in text.
    const words = statesPage().map((cell) => cell.word);
    expect(words.filter(Boolean)).toHaveLength(12);
    expect(new Set(words).size).toBe(12);
  });
});
