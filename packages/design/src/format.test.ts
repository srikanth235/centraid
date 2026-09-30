import { describe, expect, test } from "vitest";

import {
  formatBytes,
  formatRelativeTime,
  fmtMoney,
  localDayKey,
  minorUnitExponent,
} from "./format.js";

describe("canonical formatter contract", () => {
  test("formatBytes uses one binary scale across profiles", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(5 * 1024 ** 2)).toBe("5.0 MB");
    expect(formatBytes(-1)).toBe("—");
  });

  test("formatRelativeTime is deterministic when the clock is supplied", () => {
    const now = Date.parse("2026-08-02T00:00:00Z");
    expect(formatRelativeTime(undefined, now)).toBe("Recently");
    expect(formatRelativeTime(now - 30_000, now)).toBe("just now");
    expect(formatRelativeTime(now - 90 * 60_000, now)).toBe("1h ago");
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe("2d ago");
  });

  test("fmtMoney uses minor units and falls back on a bad ISO code", () => {
    expect(fmtMoney(1234, "USD")).toMatch(/12[.,]34/u);
    expect(fmtMoney(null, "not-a-code")).toMatch(/0[.,]00/u);
    expect(fmtMoney(undefined)).toMatch(/0[.,]00/u);
  });

  test("localDayKey keys the named zone, never the UTC prefix", () => {
    const instant = "2026-08-21T23:00:00Z";
    expect(instant.slice(0, 10)).toBe("2026-08-21");
    expect(localDayKey(instant, "UTC")).toBe("2026-08-21");
    expect(localDayKey(instant, "Pacific/Kiritimati")).toBe("2026-08-22");
  });
  // MINOR UNITS AND THE LOCALE (#1020, R-1020-35).
  test("fmtMoney scales by the currency's ISO 4217 exponent", () => {
    // Red before the fix: "¥12.34" — a hundredfold error on the member's own
    // money, in the direction that makes a ledger look settled.
    expect(fmtMoney(1234, "JPY")).toBe("¥1,234");
    expect(fmtMoney(1234, "KRW")).toBe("₩1,234");
    // Red before the fix: "KWD 15.00" — ten times the real amount.
    expect(fmtMoney(1500, "KWD")).toMatch(/1\.500/u);
    expect(fmtMoney(1500, "BHD")).toMatch(/1\.500/u);
    // The common exponent is unchanged, and an unlisted code takes it.
    expect(fmtMoney(1234, "USD")).toBe("$12.34");
    expect(fmtMoney(1234, "ZZZ")).toMatch(/12\.34/u);
    expect(minorUnitExponent("jpy")).toBe(0);
    expect(minorUnitExponent("kwd")).toBe(3);
    expect(minorUnitExponent("eur")).toBe(2);
  });

  test("fmtMoney formats the same input identically under two host locales", () => {
    // The locale is an argument, so the same row renders the same on a phone
    // and a desktop; before the fix `undefined` meant "whatever this device is
    // set to" and a fixture's bytes depended on the machine.
    expect(fmtMoney(123_456, "USD", "en-US")).toBe("$1,234.56");
    expect(fmtMoney(123_456, "USD", "de-DE")).not.toBe(
      fmtMoney(123_456, "USD", "en-US")
    );
    expect(fmtMoney(123_456, "USD")).toBe(fmtMoney(123_456, "USD", "en-US"));
  });
});
