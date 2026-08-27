// REVIEW'S TWO REGISTERS, AND THE THIRD FACT BETWEEN THEM.
//
// The state this file exists for is the last block: a check whose source the
// read does not carry must NOT report a zero. "Checked, and found none" is a
// reassurance; "not asked" is a gap. A review surface that says the first when
// the second is true is the single failure this whole screen exists to avoid.

import { describe, expect, it } from "vitest";

import { daysUntilExpiry, isExpiringSoon, matchesCheck } from "./format.ts";
import { reviewRegister, servedFields } from "./review-model.ts";
import { UNRUNNABLE_CHECKS } from "./route-copy.ts";
import type { LockerRow } from "./types.ts";

const NOW = Date.parse("2026-01-15T00:00:00Z");

function row(over: Partial<LockerRow> & { item_id: string }): LockerRow {
  return { type: "login", title: over.item_id, ...over };
}

/** A window whose rows carry the three metadata fields the checks read — what
 *  the items query hands back since #872 decorated them. */
const SERVED: LockerRow[] = [
  row({
    item_id: "a",
    compromised: true,
    url: "https://one.example",
    password_set_at: "2025-06-01T00:00:00Z",
  }),
  row({
    item_id: "b",
    weak: true,
    url: "http://two.example",
    password_set_at: "2020-01-01T00:00:00Z",
  }),
  row({
    item_id: "c",
    weak: true,
    reused: true,
    url: "https://three.example",
    password_set_at: "2025-12-01T00:00:00Z",
  }),
  row({
    item_id: "d",
    reused: true,
    url: "https://four.example",
    password_set_at: "2025-12-01T00:00:00Z",
  }),
  row({
    item_id: "e",
    type: "card",
    expiry: "02 / 26",
    url: "",
    password_set_at: "2025-12-01T00:00:00Z",
  }),
];

/** A read that stopped carrying them. The register must then say "not asked"
 *  rather than reporting a zero — which is the state this file exists for. */
const UNSERVED: LockerRow[] = SERVED.map(
  ({ url: _url, expiry: _expiry, password_set_at: _setAt, ...rest }) => rest
);

describe("what the payload carries decides what can be checked", () => {
  it("sees all three when the rows carry them", () => {
    expect(servedFields(SERVED)).toStrictEqual({
      address: true,
      expiry: true,
      age: true,
    });
  });

  it("sees none of them on a read that dropped them", () => {
    expect(servedFields(UNSERVED)).toStrictEqual({
      address: false,
      expiry: false,
      age: false,
    });
  });
});

describe("Needs attention is one row per verdict, with its count", () => {
  const register = reviewRegister(SERVED, NOW);

  it("names every check that found something, worst first", () => {
    expect(register.attention.map((verdict) => verdict.key)).toStrictEqual([
      "compromised",
      "weak",
      "reused",
      "http",
      "expiring",
      "age",
    ]);
    expect(register.attention.map((verdict) => verdict.count)).toStrictEqual([
      1, 2, 2, 1, 1, 1,
    ]);
  });

  it("spends `--net` on compromised alone — the one verdict with a consequence off this device", () => {
    const tones = Object.fromEntries(
      register.attention.map((verdict) => [verdict.key, verdict.tone])
    );
    expect(tones["compromised"]).toBe("net");
    expect(tones["weak"]).toBe("seam");
    expect(tones["http"]).toBe("seam");
  });

  it("counts the verdicts, not the rows — one row can hold two", () => {
    expect(register.verdicts).toBe(8);
    expect(register.items).toHaveLength(5);
    expect(register.items.map((held) => held.item_id)).toStrictEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  it("carries each check's reason, and no gap tag survives on any of them", () => {
    const http = register.attention.find((verdict) => verdict.key === "http");
    expect(http?.why).toContain("the list read carries it");
    for (const verdict of register.attention) {
      expect(verdict.why).not.toContain("[backend-needed]");
      expect(verdict.why).not.toContain("[exists]");
    }
  });

  it("PASSWORD AGE RUNS NOW — the check that wanted item history (GAPS #6d)", () => {
    const age = register.attention.find((verdict) => verdict.key === "age");
    expect(age?.count).toBe(1);
    expect(age?.items.map((held) => held.item_id)).toStrictEqual(["b"]);
  });
});

describe("Checked, and cannot be checked", () => {
  it("lists the two that have no source at all, and only those", () => {
    const register = reviewRegister(SERVED, NOW);
    const keys = register.unrunnable.map((check) => check.key);
    expect(keys).toStrictEqual(UNRUNNABLE_CHECKS.map((check) => check.key));
    // Password age LEFT this register when the read started carrying its
    // source; the two that remain are rulings, not deferrals.
    expect(keys).toStrictEqual(["2fa", "breach"]);
  });

  it("NAMES AN UNSERVED READ RATHER THAN REPORTING A ZERO", () => {
    const register = reviewRegister(UNSERVED, NOW);
    const keys = register.unrunnable.map((check) => check.key);
    expect(keys).toContain("http");
    expect(keys).toContain("expiring");
    expect(keys).toContain("age");
    // …and neither appears as a verdict with a count of nothing.
    expect(register.attention.map((verdict) => verdict.key)).toStrictEqual([
      "compromised",
      "weak",
      "reused",
    ]);
    expect(register.ran).toStrictEqual(["compromised", "weak", "reused"]);
    const unserved = register.unrunnable.find((check) => check.key === "http");
    expect(unserved?.why).toContain("nothing was checked");
  });
});

describe("ALL CLEAR is a state, not an absence", () => {
  it("holds when every check that ran found nothing", () => {
    const register = reviewRegister(
      [row({ item_id: "x", url: "https://ok.example" })],
      NOW
    );
    expect(register.allClear).toBe(true);
    expect(register.attention).toHaveLength(0);
    // It still knows what it checked, which is what the screen says.
    expect(register.ran).toStrictEqual([
      "compromised",
      "weak",
      "reused",
      "http",
    ]);
  });

  it("does not hold while anything carries a verdict", () => {
    expect(reviewRegister(SERVED, NOW).allClear).toBe(false);
  });
});

describe("the two pure reads", () => {
  it("reads an expiry as the end of its stated month, in three dialects", () => {
    expect(daysUntilExpiry("02 / 26", NOW)).toBe(45);
    expect(daysUntilExpiry("2/2026", NOW)).toBe(45);
    expect(daysUntilExpiry("2026-02", NOW)).toBe(45);
  });

  it("refuses to guess at anything else", () => {
    expect(daysUntilExpiry("soon", NOW)).toBeNull();
    expect(daysUntilExpiry("", NOW)).toBeNull();
    expect(daysUntilExpiry(null, NOW)).toBeNull();
    expect(daysUntilExpiry("13/26", NOW)).toBeNull();
  });

  it("flags a card inside ninety days and nothing else", () => {
    const card = row({ item_id: "c", type: "card", expiry: "02 / 26" });
    expect(isExpiringSoon(card, NOW)).toBe(true);
    expect(isExpiringSoon({ ...card, expiry: "02 / 29" }, NOW)).toBe(false);
    // A login is not a card, whatever it holds in that column.
    expect(isExpiringSoon({ ...card, type: "login" }, NOW)).toBe(false);
  });

  it("calls http insecure and an unknown scheme UNKNOWN", () => {
    expect(
      matchesCheck(row({ item_id: "1", url: "http://a" }), "http", NOW)
    ).toBe(true);
    expect(
      matchesCheck(row({ item_id: "2", url: "https://a" }), "http", NOW)
    ).toBe(false);
    // A bare host has no scheme to be insecure with.
    expect(
      matchesCheck(row({ item_id: "3", url: "a.example" }), "http", NOW)
    ).toBe(false);
  });
});
