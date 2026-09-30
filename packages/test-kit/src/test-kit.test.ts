import { accessSync } from "node:fs";
import { access } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { useFakeClock } from "./fake-clock.js";
import { fc } from "./fast-check.js";
import { flushMacrotasks } from "./flush.js";
import { forEachSequentially } from "./sequential.js";
import { tempDir, tempDirSync } from "./temp-dir.js";
import { jsdomProject, nodeProject } from "./vitest.js";

describe("test-kit", () => {
  test("tempDir creates an accessible tracked directory", async () => {
    const dir = await tempDir("centraid-kit-");
    await expect(access(dir)).resolves.toBeUndefined();
  });

  test("tempDirSync supports synchronous hooks and constructors", () => {
    expect(() => accessSync(tempDirSync("centraid-kit-sync-"))).not.toThrow();
  });

  test("fake clock advances deterministically", async () => {
    const clock = useFakeClock("2026-07-18T00:00:00Z");
    const before = clock.now();
    await clock.advance(2_500);
    expect(clock.now()).toBe(before + 2_500);
  });

  test("fast-check re-export runs a property", () => {
    let runs = 0;
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        runs += 1;
        return a + b === b + a;
      }),
      { numRuns: 32 }
    );
    expect(runs).toBeGreaterThan(0);
  });

  test("forEachSequentially starts each item only after its predecessor settles", async () => {
    let releaseFirst = () => {};
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: number[] = [];
    const sequence = forEachSequentially([1, 2, 3], (value) => {
      started.push(value);
      return value === 1 ? first : undefined;
    });

    await Promise.resolve();
    expect(started).toStrictEqual([1]);

    releaseFirst();
    await sequence;
    expect(started).toStrictEqual([1, 2, 3]);
  });

  test("forEachSequentially does not start later items after a failure", async () => {
    const failure = new Error("stop");
    const started: number[] = [];

    await expect(
      forEachSequentially([1, 2, 3], (value) => {
        started.push(value);
        if (value === 2) throw failure;
      })
    ).rejects.toBe(failure);
    expect(started).toStrictEqual([1, 2]);
  });

  test("nodeProject merges requireAssertions and the node environment", () => {
    const project = nodeProject({
      test: { name: "kit-node-probe", include: ["src/**/*.test.ts"] },
    });
    const cfg = project as {
      test?: { environment?: string; expect?: { requireAssertions?: boolean } };
    };
    expect(cfg.test?.environment).toBe("node");
    expect(cfg.test?.expect?.requireAssertions).toBe(true);
  });

  test("jsdomProject enables automatic JSX and jsdom setup", () => {
    const project = jsdomProject({
      test: { name: "kit-jsdom-probe", include: ["src/**/*.test.tsx"] },
    });
    const cfg = project as {
      esbuild?: { jsx?: string };
      test?: { environment?: string; setupFiles?: string[] };
    };
    expect(cfg.test?.environment).toBe("jsdom");
    expect(cfg.esbuild?.jsx).toBe("automatic");
    expect(cfg.test?.setupFiles?.some((p) => p.includes("jsdom-setup"))).toBe(
      true
    );
  });

  test("flushMacrotasks resolves after already-queued macrotask work", async () => {
    const order: string[] = [];
    setTimeout(() => order.push("queued"), 0);
    await flushMacrotasks();
    expect(order).toStrictEqual(["queued"]);
  });
});
