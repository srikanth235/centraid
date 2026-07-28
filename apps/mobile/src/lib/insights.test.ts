/* oxlint-disable import/first -- vi.mock is hoisted; subject imports intentionally follow */
/**
 * Insights owner (issue #545 C6) — pure format helpers the Insights screen uses.
 * Gateway fetch helpers are mocked so vitest never loads react-native.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock(import("./gateway") as Promise<unknown>, () => ({
  apiHeaders: () => ({}),
  authHeader: () => ({}),
  // `fetchJson` is generic (`<T>(href, init?) => Promise<T>`); a typed mock erases
  // the type parameter, so `Mock<...>` stops being assignable to the export.
  fetchJson: vi.fn<typeof import("./gateway").fetchJson>(),
  requireGatewayBase: vi.fn<typeof import("./gateway").requireGatewayBase>(
    async () => "http://127.0.0.1:9"
  ),
}));

import {
  formatBytes,
  formatCount,
  formatMs,
  formatUsd,
  formatUptime,
  relativeTime,
} from "./insights";

describe("Insights format helpers", () => {
  it("formatCount compresses large magnitudes", () => {
    expect(formatCount(987)).toBe("987");
    expect(formatCount(1_200)).toBe("1.2k");
    expect(formatCount(3_000_000)).toBe("3M");
    expect(formatCount(Number.NaN)).toBe("0");
  });

  it("formatUsd handles sub-cent and zero", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(1.239)).toBe("$1.24");
    expect(formatUsd(Number.NaN)).toBe("$0.00");
  });

  it("formatBytes picks MB / GB", () => {
    expect(formatBytes(0)).toBe("0 MB");
    expect(formatBytes(50 * 1024 * 1024)).toBe("50 MB");
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.5 GB");
  });

  it("formatUptime and formatMs cover coarse buckets", () => {
    expect(formatUptime(0)).toBe("—");
    expect(formatUptime(12 * 60_000)).toBe("12m");
    expect(formatUptime(5 * 60 * 60_000 + 12 * 60_000)).toBe("5h 12m");
    expect(formatUptime(3 * 24 * 60 * 60_000 + 4 * 60 * 60_000)).toBe("3d 4h");
    expect(formatMs(0.8)).toBe("0.8 ms");
    expect(formatMs(42.2)).toBe("42 ms");
    expect(formatMs(Number.NaN)).toBe("—");
  });

  describe(relativeTime, () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("renders just now / minutes / hours / days", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-25T12:00:00.000Z"));
      expect(relativeTime(Date.now() - 10_000)).toBe("just now");
      expect(relativeTime(Date.now() - 5 * 60_000)).toBe("5m ago");
      expect(relativeTime(Date.now() - 3 * 60 * 60_000)).toBe("3h ago");
      expect(relativeTime(Date.now() - 2 * 24 * 60 * 60_000)).toBe("2d ago");
      expect(relativeTime("not-a-date")).toBe("");
    });
  });
});
