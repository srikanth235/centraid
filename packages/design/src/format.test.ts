import { describe, expect, test } from "vitest";

import {
  formatBytes,
  formatRelativeTime,
  fmtMoney,
  localDayKey,
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
});
