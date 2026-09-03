import { describe, expect, it } from "vitest";

import { maestroChunkTimeoutMs } from "./harness.mjs";
import { fitsInBudget } from "./run-suite.mjs";

describe("fitsInBudget", () => {
  it("refuses an attempt when the budget is already spent", () => {
    expect(fitsInBudget(0, 1_000)).toBe(false);
    expect(fitsInBudget(-5_000, 1_000)).toBe(false);
  });

  it("refuses a retry that costs more than the time left", () => {
    expect(fitsInBudget(90_000, 4 * 60_000)).toBe(false);
  });

  it("allows a retry that fits, including exactly", () => {
    expect(fitsInBudget(5 * 60_000, 4 * 60_000)).toBe(true);
    expect(fitsInBudget(60_000, 60_000)).toBe(true);
  });
});

describe("maestroChunkTimeoutMs", () => {
  const withDeadline = (value, body) => {
    const previous = process.env.CENTRAID_MOBILE_DEADLINE_MS;
    if (value == null) delete process.env.CENTRAID_MOBILE_DEADLINE_MS;
    else process.env.CENTRAID_MOBILE_DEADLINE_MS = value;
    try {
      return body();
    } finally {
      if (previous == null) delete process.env.CENTRAID_MOBILE_DEADLINE_MS;
      else process.env.CENTRAID_MOBILE_DEADLINE_MS = previous;
    }
  };

  it("keeps the flat ceiling when no suite published a deadline", () => {
    expect(withDeadline(null, () => maestroChunkTimeoutMs(1_000))).toBe(
      12 * 60_000
    );
  });

  it("ignores a malformed deadline rather than clamping to nonsense", () => {
    expect(
      withDeadline("not-a-number", () => maestroChunkTimeoutMs(1_000))
    ).toBe(12 * 60_000);
  });

  it("clamps a chunk to the time the suite has left", () => {
    const now = 1_000_000;
    expect(
      withDeadline(String(now + 90_000), () => maestroChunkTimeoutMs(now))
    ).toBe(90_000);
  });

  it("never returns a ceiling too short for Maestro to connect", () => {
    const now = 1_000_000;
    expect(
      withDeadline(String(now + 200), () => maestroChunkTimeoutMs(now))
    ).toBe(15_000);
  });

  it("does not widen a chunk past the flat ceiling on a generous deadline", () => {
    const now = 1_000_000;
    expect(
      withDeadline(String(now + 60 * 60_000), () => maestroChunkTimeoutMs(now))
    ).toBe(12 * 60_000);
  });
});
