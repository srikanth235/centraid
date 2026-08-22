/*
 * Restore-drill unit contracts (umbrella #842, slice W1.3).
 *
 * The grading rules and the deterministic sampler, exercised directly. The
 * end-to-end proof that a real backup restores to a usable vault — and the
 * demonstrated-red that the drill bites — is the sibling integration lane in
 * `restore-drill.integration.test.ts`; this file pins the judgement calls the
 * integration lane cannot vary cheaply.
 *
 * Determinism: no clock, no `Math.random`. The sampler's seed is the test's
 * own name, so any distribution assertion here replays exactly.
 */

import { describe, expect, test } from "vitest";

import { checkRestoredCensus, seededRandom } from "./restore-drill.js";
import type { SpineCensus } from "./restore-drill.js";

const FULL: SpineCensus = { party: 1, content: 4, media: 2, receipt: 3 };

describe("restore-drill census grading", () => {
  test("a fully populated restore with a live source is ok", () => {
    const found = checkRestoredCensus({
      vaultId: "v1",
      restored: FULL,
      source: FULL,
    });
    expect(found.level).toBe("ok");
    expect(found.check).toBe("restored-census");
    expect(found.detail).toContain("party=1");
  });

  test("zero parties is an ERROR — a founded vault is never partyless", () => {
    // The empty-shell restore: structurally perfect, nobody home. Every
    // structural check in `verifyRestoredPair` passes on this pair, which is
    // exactly why the drill has to be the check that fails it.
    const found = checkRestoredCensus({
      vaultId: "v1",
      restored: { party: 0, content: 0, media: 0, receipt: 0 },
      source: FULL,
    });
    expect(found.level).toBe("error");
    expect(found.detail).toContain("EMPTY SHELL");
  });

  test("zero parties fails even with no source to compare against", () => {
    // The party invariant is intrinsic to the restored pair, so an unmounted
    // plane never downgrades it to the softer 'could not compare' warning.
    const found = checkRestoredCensus({
      vaultId: "v1",
      restored: { party: 0, content: 9, media: 9, receipt: 9 },
    });
    expect(found.level).toBe("error");
  });

  test("a spine table that restored empty DEGRADES, it does not fail", () => {
    // A snapshot taken before the owner added a photo restores zero media
    // rows truthfully. Needs eyes; not an alarm.
    const found = checkRestoredCensus({
      vaultId: "v1",
      restored: { party: 1, content: 4, media: 0, receipt: 3 },
      source: FULL,
    });
    expect(found.level).toBe("warning");
    expect(found.detail).toContain("media restored 0 of 2 live row(s)");
    expect(found.detail).toContain("needs eyes");
  });

  test("a restore merely BEHIND the source is ok, not a degrade", () => {
    // Point-in-time is the whole point of a snapshot: fewer rows is expected.
    const found = checkRestoredCensus({
      vaultId: "v1",
      restored: { party: 1, content: 1, media: 1, receipt: 1 },
      source: FULL,
    });
    expect(found.level).toBe("ok");
  });

  test("an unmounted source plane WARNS rather than passing vacuously", () => {
    // A drill that could not make its comparison must say so — a silent ok
    // here would be the gate reading as green because it did not run.
    const found = checkRestoredCensus({ vaultId: "v1", restored: FULL });
    expect(found.level).toBe("warning");
    expect(found.detail).toContain("not mounted");
  });
});

describe("restore-drill seeded sampler", () => {
  test("the same seed replays the same stream, a different seed does not", () => {
    const seed = "restore-drill seeded sampler/replays";
    const a = seededRandom(seed);
    const b = seededRandom(seed);
    const c = seededRandom(`${seed}!`);
    const draw = (rng: () => number): number[] =>
      Array.from({ length: 8 }, () => rng());
    const first = draw(a);
    expect(draw(b)).toStrictEqual(first);
    expect(draw(c)).not.toStrictEqual(first);
  });

  test("every draw lies in [0, 1)", () => {
    const rng = seededRandom("restore-drill seeded sampler/range");
    for (let i = 0; i < 512; i += 1) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});
