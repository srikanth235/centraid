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
    const found = checkRestoredCensus({
      vaultId: "v1",
      restored: { party: 0, content: 0, media: 0, receipt: 0 },
      source: FULL,
    });
    expect(found.level).toBe("error");
    expect(found.detail).toContain("EMPTY SHELL");
  });

  test("zero parties fails even with no source to compare against", () => {
    const found = checkRestoredCensus({
      vaultId: "v1",
      restored: { party: 0, content: 9, media: 9, receipt: 9 },
    });
    expect(found.level).toBe("error");
  });

  test("a spine table that restored empty DEGRADES, it does not fail", () => {
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
    const found = checkRestoredCensus({
      vaultId: "v1",
      restored: { party: 1, content: 1, media: 1, receipt: 1 },
      source: FULL,
    });
    expect(found.level).toBe("ok");
  });

  test("an unmounted source plane WARNS rather than passing vacuously", () => {
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
