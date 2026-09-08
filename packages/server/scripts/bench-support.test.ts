import { describe, expect, test } from "vitest";

import {
  argReader,
  fsyncCallsIn,
  hostRecord,
  latencySummary,
  percentile,
  ratePerHour,
  resolvedProfileFrom,
} from "./bench-support.mjs";

describe("benchmark support", () => {
  test("both flag spellings resolve, and a bad count is refused", () => {
    const inline = argReader(["--intents=40", "--profile=standard"]);
    expect(inline.option("--profile", "")).toBe("standard");
    expect(inline.positiveInteger("--intents", 1)).toBe(40);
    const spaced = argReader(["--intents", "12"]);
    expect(spaced.positiveInteger("--intents", 1)).toBe(12);
    expect(spaced.positiveInteger("--absent", 7)).toBe(7);
    expect(() =>
      argReader(["--intents", "0"]).positiveInteger("--intents", 1)
    ).toThrow(/positive integer/u);
    expect(() =>
      argReader(["--intents", "1.5"]).positiveInteger("--intents", 1)
    ).toThrow(/positive integer/u);
  });

  test("percentiles pick the sample at or above the fraction", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 0.5)).toBe(5);
    expect(percentile(sorted, 0.99)).toBe(10);
    expect(percentile([], 0.5)).toBe(0);
  });

  test("a summary sorts defensively and reports an empty sample as zeros", () => {
    expect(latencySummary([9, 1, 5])).toStrictEqual({
      count: 3,
      p50Ms: 5,
      p99Ms: 9,
      maxMs: 9,
      meanMs: 5,
    });
    expect(latencySummary([])).toStrictEqual({
      count: 0,
      p50Ms: 0,
      p99Ms: 0,
      maxMs: 0,
      meanMs: 0,
    });
  });

  test("an hourly rate needs a positive window", () => {
    expect(ratePerHour(10, 3_600_000)).toBe(10);
    expect(ratePerHour(10, 0)).toBe(0);
  });

  test("fsync counting is bracketed by the markers and splits count once", () => {
    const trace = [
      'openat(AT_FDCWD, "/tmp/before", O_WRONLY) = 3',
      "fsync(7) = 0",
      'openat(AT_FDCWD, "/tmp/epoch.start", O_WRONLY) = 3',
      "fsync(7) = 0",
      "fdatasync(8) = 0",
      "fsync(9 <unfinished ...>",
      "<... fsync resumed>) = 0",
      'openat(AT_FDCWD, "/tmp/epoch.end", O_WRONLY) = 3',
      "fsync(7) = 0",
    ].join("\n");
    expect(fsyncCallsIn(trace, "/tmp/epoch")).toBe(3);
    expect(() => fsyncCallsIn("fsync(7) = 0", "/tmp/epoch")).toThrow(
      /markers are missing/u
    );
  });

  test("the resolved profile is read from the health component, not re-derived", () => {
    const health = {
      components: [
        { component: "disk", status: "ok", detail: "irrelevant" },
        {
          component: "hardware-profile",
          status: "ok",
          detail:
            "mode=Auto (auto); class=standard; sqlite=FULL; workers=8x256MB; pool=2; replication=3; mount=eager; sweep=3600000ms",
        },
      ],
    };
    expect(resolvedProfileFrom(health)).toStrictEqual({
      detail: health.components[1]!.detail,
      class: "standard",
      sqliteSynchronous: "FULL",
      workerPoolSize: 2,
    });
    expect(resolvedProfileFrom({ components: [] })).toStrictEqual({
      detail: "",
      class: null,
      sqliteSynchronous: null,
      workerPoolSize: null,
    });
  });

  test("provenance names the host and the requested profile", () => {
    const host = hostRecord();
    expect(host.platform).toBe(process.platform);
    expect(host.node).toBe(process.version);
    expect(host.cpus).toBeGreaterThan(0);
    expect(host.requestedHardwareProfile).toBe(
      process.env.CENTRAID_HARDWARE_PROFILE ?? "auto"
    );
  });
});
