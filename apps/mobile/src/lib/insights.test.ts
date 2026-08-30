/* oxlint-disable import/first -- vi.mock is hoisted; subject imports intentionally follow */
/**
 * Insights owner (#545) — pure format helpers the Insights screen uses.
 * Gateway fetch helpers are mocked so vitest never loads react-native.
 */
import { describe, expect, it, vi } from "vitest";

import { useFakeClock } from "@centraid/test-kit/fake-clock";

vi.mock(import("./gateway") as Promise<unknown>, () => ({
  apiHeaders: () => ({}),
  authHeader: () => ({}),
  // `fetchJson` is generic (`<T>(href, init?) => Promise<T>`); a typed mock erases
  // the type parameter, so `Mock<...>` stops being assignable to the export.
  fetchJson: vi.fn<typeof TypeImport_3w09v8.fetchJson>(),
  requireGatewayBase: vi.fn<typeof TypeImport_3w09v8.requireGatewayBase>(
    async () => "http://127.0.0.1:9"
  ),
}));

import type * as TypeImport_3w09v8 from "./gateway";
import {
  formatBytes,
  formatCount,
  formatMs,
  formatUsd,
  formatDuration,
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
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(50 * 1024 * 1024)).toBe("50.0 MB");
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

  it("formatDuration keeps a sub-second run in ms rather than calling it 0s", () => {
    expect(formatDuration(0)).toBe("0 ms");
    expect(formatDuration(420)).toBe("420 ms");
    expect(formatDuration(1400)).toBe("1s");
    expect(formatDuration(95_000)).toBe("1m 35s");
    expect(formatDuration(120_000)).toBe("2m");
    expect(formatDuration(3 * 3_600_000 + 25 * 60_000)).toBe("3h 25m");
    expect(formatDuration(-1)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
  });

  describe(relativeTime, () => {
    it("renders just now / minutes / hours / days", () => {
      useFakeClock(new Date("2026-07-25T12:00:00.000Z"));
      expect(relativeTime(Date.now() - 10_000)).toBe("just now");
      expect(relativeTime(Date.now() - 5 * 60_000)).toBe("5m ago");
      expect(relativeTime(Date.now() - 3 * 60 * 60_000)).toBe("3h ago");
      expect(relativeTime(Date.now() - 2 * 24 * 60 * 60_000)).toBe("2d ago");
      expect(relativeTime("not-a-date")).toBe("Recently");
    });
  });
});
