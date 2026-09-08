// THE SCENARIOS, RUN (#996, wave 0e).
//
// The fixture does the work; this file only asserts what it answered. Keeping
// the two apart is the point: W1's convergence run replays the same builder in
// another package and asserts the same claims, so a reader that ignores a
// stored column is red in both places rather than only in the vault's suite.

import { afterAll, describe, expect, test } from "vitest";

import { buildOntologyScenarios } from "./build.js";

const fixture = buildOntologyScenarios();

describe("the ontology scenarios", () => {
  afterAll(() => {
    fixture.db.close();
  });

  test("every scenario names a drift row, two surfaces, and makes claims", () => {
    for (const scenario of fixture.scenarios) {
      expect(scenario.drift, scenario.id).toMatch(/^(?<row>ONT-\d+|R\d+)$/u);
      expect(scenario.surfaces, scenario.id).toHaveLength(2);
      expect(scenario.checks.length, scenario.id).toBeGreaterThan(0);
    }
    // The count the receipt and the README both quote.
    expect(fixture.scenarios).toHaveLength(13);
    expect(fixture.digest).toMatch(/^[0-9a-f]{64}$/u);
  });

  // WHAT MAKES IT A FIXTURE. Same seed, same clock, same rows in the same
  // order — otherwise a convergence test replaying it has nothing to compare
  // against. Identifiers are compared by the order they first appear, because
  // the BOOTSTRAP's ids are minted off the clock and have no seam (see
  // `stableDigest`).
  test("a second run of the same script answers identically", () => {
    const replay = buildOntologyScenarios();
    try {
      expect(replay.digest).toBe(fixture.digest);
      expect(replay.scenarios.map((scenario) => scenario.id)).toStrictEqual(
        fixture.scenarios.map((scenario) => scenario.id)
      );
    } finally {
      replay.db.close();
    }
  });

  describe.each(fixture.scenarios)("$id — $title", (scenario) => {
    test.each(scenario.checks)("$claim", (check) => {
      expect(check.actual).toStrictEqual(check.expected);
    });
  });
});
