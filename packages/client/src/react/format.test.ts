import { describe, expect, it } from "vitest";

import { relativeTime as appRelativeTime } from "../app-format.js";
import {
  INTEGRATION_HUES,
  insK,
  insKindLabel,
  insDuration,
  insUsd,
  relativeTime,
} from "./format.js";

describe("insK / insUsd / insKindLabel", () => {
  it("formats token counts and USD", () => {
    expect(insK(0)).toBe("0");
    expect(insK(999)).toBe("999");
    expect(insK(12_300)).toBe("12k");
    expect(insK(2_500_000)).toBe("2.50M");
    expect(insUsd(0)).toBe("$0.00");
    expect(insUsd(0.001)).toBe("<$0.01");
    expect(insUsd(1.2)).toBe("$1.20");
  });

  it("maps known run kinds and passes others through", () => {
    expect(insKindLabel("chat")).toBe("Chat");
    expect(insKindLabel("build")).toBe("Build");
    expect(insKindLabel("automation")).toBe("Automation");
    expect(insKindLabel("other")).toBe("other");
  });

  it("exposes integration hues for known names", () => {
    expect(INTEGRATION_HUES.Slack).toBe("violet");
    expect(INTEGRATION_HUES.GitHub).toBe("slate");
  });
});

describe(insDuration, () => {
  it("keeps a sub-second run in ms rather than calling it 0s", () => {
    expect(insDuration(0)).toBe("0 ms");
    expect(insDuration(420)).toBe("420 ms");
    expect(insDuration(1400)).toBe("1s");
    expect(insDuration(95_000)).toBe("1m 35s");
    expect(insDuration(120_000)).toBe("2m");
    expect(insDuration(3 * 3_600_000 + 25 * 60_000)).toBe("3h 25m");
    expect(insDuration(-1)).toBe("—");
    expect(insDuration(Number.NaN)).toBe("—");
  });
});

describe("relativeTime parity with app-format", () => {
  const now = Date.parse("2026-07-25T12:00:00.000Z");

  it("handles missing / invalid ISO", () => {
    expect(relativeTime(undefined, now)).toBe("Recently");
    expect(relativeTime("not-a-date", now)).toBe("Recently");
  });

  it("matches app-format coarse buckets when Date.now is pinned", () => {
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const cases = [
        new Date(now - 10_000).toISOString(), // just now
        new Date(now - 5 * 60_000).toISOString(), // 5m
        new Date(now - 3 * 3_600_000).toISOString(), // 3h
        new Date(now - 2 * 86_400_000).toISOString(), // 2d
      ];
      for (const iso of cases) {
        expect(relativeTime(iso, now)).toBe(appRelativeTime(iso));
      }
    } finally {
      Date.now = realNow;
    }
  });
});
