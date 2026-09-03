import { describe, expect, test } from "vitest";

import { parseDay, readQuarantine, validateQuarantine } from "./quarantine.mjs";

const NOW = Date.parse("2026-07-31T12:00:00Z");

const entry = (overrides = {}) => ({
  owner: "packages/tunnel/src/native-relay.test.ts",
  issue: 657,
  reason: "dials a real relay and times out under CI contention",
  quarantinedAt: "2026-07-20",
  expiresAt: "2026-08-10",
  ...overrides,
});

const doc = (entries, policy = {}) => ({
  _policy: { maxDays: 30, budget: entries.length, ...policy },
  entries,
});

describe("flake quarantine protocol", () => {
  test("accepts an entry that cites an issue, a reason, and a live expiry", () => {
    expect(validateQuarantine(doc([entry()]), NOW).errors).toEqual([]);
  });

  test("an expired entry is a hard failure, so debt cannot be parked forever", () => {
    const errors = validateQuarantine(
      doc([entry({ expiresAt: "2026-07-30" })]),
      NOW
    ).errors;
    expect(errors.some((error) => error.includes("EXPIRED"))).toBe(true);
  });

  test("expiry is exclusive at the boundary — the last day is already spent", () => {
    const sameDay = Date.parse("2026-08-10T00:00:00Z");
    expect(
      validateQuarantine(doc([entry()]), sameDay).errors.some((error) =>
        error.includes("EXPIRED")
      )
    ).toBe(true);
    expect(
      validateQuarantine(doc([entry()]), sameDay - 1).errors.some((error) =>
        error.includes("EXPIRED")
      )
    ).toBe(false);
  });

  test("a quarantine with no owning issue is refused", () => {
    expect(
      validateQuarantine(doc([entry({ issue: undefined })]), NOW).errors.some(
        (error) => error.includes("real GitHub issue")
      )
    ).toBe(true);
  });

  test("'flaky' is not a reason", () => {
    expect(
      validateQuarantine(doc([entry({ reason: "flaky" })]), NOW).errors.some(
        (error) => error.includes("HOW it flakes")
      )
    ).toBe(true);
  });

  test("a quarantine longer than the policy window is refused", () => {
    expect(
      validateQuarantine(
        doc([entry({ quarantinedAt: "2026-07-20", expiresAt: "2026-09-30" })]),
        NOW
      ).errors.some((error) => error.includes("30-day policy"))
    ).toBe(true);
  });

  test("the budget is a ceiling AND a ratchet — over fails, under demands tightening", () => {
    expect(
      validateQuarantine(doc([entry()], { budget: 0 }), NOW).errors.some(
        (error) => error.includes("exceeds the budget")
      )
    ).toBe(true);
    expect(
      validateQuarantine(doc([], { budget: 1 }), NOW).errors.some((error) =>
        error.includes("ratchet")
      )
    ).toBe(true);
  });

  test("the same owner cannot be quarantined twice", () => {
    expect(
      validateQuarantine(doc([entry(), entry()]), NOW).errors.some((error) =>
        error.includes("quarantined twice")
      )
    ).toBe(true);
  });

  test("a malformed date is refused rather than treated as never-expiring", () => {
    expect(parseDay("2026-8-10")).toBeNull();
    expect(parseDay("tomorrow")).toBeNull();
    expect(
      validateQuarantine(doc([entry({ expiresAt: "tomorrow" })]), NOW).errors
        .length
    ).toBeGreaterThan(0);
  });

  test("the committed quarantine file satisfies its own protocol", () => {
    expect(validateQuarantine(readQuarantine(), NOW).errors).toEqual([]);
  });
});
