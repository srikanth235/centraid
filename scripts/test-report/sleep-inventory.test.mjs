import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import {
  SCAN_EXCLUDE,
  SCAN_INCLUDE,
  countSleepSites,
  discoverSleepSites,
  isWatchdog,
  reconcileInventory,
  topOffenders,
  totalSites,
  validateSleepInventory,
} from "./sleep-inventory.mjs";

describe("countSleepSites", () => {
  test("counts every fixed-sleep shape once", () => {
    const source = [
      // Promise-wrapped, one line.
      "await new Promise((r) => setTimeout(r, 50));",
      // Promise-wrapped, formatter-split across lines.
      "await new Promise((resolve) => {",
      "  setTimeout(resolve, 1_000);",
      "});",
      // Arrow first argument.
      "setTimeout(() => resolve({}), 100);",
      // Poll-loop delay.
      "setTimeout(poll, 5);",
      // Helper aliases (setTimeout as sleep from node:timers/promises, local delay/pause).
      "await sleep(2000);",
      "await delay(20);",
      "await pause(500);",
    ].join("\n");
    expect(countSleepSites(source)).toBe(7);
  });

  test("a 0ms yield is not a sleep", () => {
    expect(countSleepSites("await new Promise((r) => setTimeout(r, 0));")).toBe(
      0
    );
    expect(countSleepSites("await sleep(0);")).toBe(0);
  });

  test("a non-literal delay is not counted — the budget covers hard-coded waits", () => {
    expect(countSleepSites("setTimeout(resolve, timeoutMs);")).toBe(0);
    expect(countSleepSites("await sleep(500 * (attempt + 1));")).toBe(0);
  });

  test("a rejecting deadline is a watchdog on an event-driven wait, not a sleep", () => {
    const watchdog = [
      "const timer = setTimeout(",
      '  () => reject(new Error("timed out waiting for the event")),',
      "  10_000",
      ");",
    ].join("\n");
    expect(isWatchdog(watchdog)).toBe(true);
    expect(countSleepSites(watchdog)).toBe(0);
  });

  test("fake-clock advances and setImmediate are invisible to the scan", () => {
    expect(
      countSleepSites("await clock.advance(5000);\nsetImmediate(resolve);")
    ).toBe(0);
  });

  test("non-string input counts zero rather than throwing", () => {
    expect(countSleepSites(null)).toBe(0);
    expect(countSleepSites("")).toBe(0);
  });
});

describe("discoverSleepSites", () => {
  /**
   * Write one file (creating parents) under a scratch root.
   * @param {string} root Scratch root.
   * @param {string} file Repo-relative path.
   * @param {string} source File contents.
   */
  function writeFixture(root, file, source) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, source);
  }

  test("walks the skip-budget population, including nested script tests and flows", async () => {
    const root = tempDirSync("sleep-inventory-");
    writeFixture(
      root,
      "packages/x/src/a.test.ts",
      "await new Promise((r) => setTimeout(r, 50));\nawait sleep(100);"
    );
    writeFixture(
      root,
      "scripts/gateway-package/nested.test.mjs",
      "setTimeout(resolve, 250);"
    );
    writeFixture(
      root,
      "tests/agent-e2e-pairing/flows/flow.mjs",
      "await new Promise((resolve) => {\n  setTimeout(resolve, 500);\n});"
    );
    writeFixture(root, "packages/x/src/clean.test.ts", "expect(1).toBe(1);");
    expect(await discoverSleepSites({ root })).toStrictEqual({
      "packages/x/src/a.test.ts": 2,
      "scripts/gateway-package/nested.test.mjs": 1,
      "tests/agent-e2e-pairing/flows/flow.mjs": 1,
    });
  });

  test("exempts the detectors' fixtures and the test-kit's own seam tests", async () => {
    const root = tempDirSync("sleep-inventory-");
    writeFixture(
      root,
      "scripts/test-report/detector.test.mjs",
      "setTimeout(resolve, 50);"
    );
    // The kit's seam tests schedule literal timers under useFakeClock() to
    // prove the fake clock runs them — never real time.
    writeFixture(
      root,
      "packages/test-kit/src/seams.test.ts",
      "setTimeout(() => undefined, 1_000);"
    );
    expect(SCAN_EXCLUDE).toContain("scripts/test-report/");
    expect(SCAN_EXCLUDE).toContain("packages/test-kit/");
    expect(SCAN_INCLUDE.some((pattern) => pattern.startsWith("tests/"))).toBe(
      true
    );
    expect(await discoverSleepSites({ root })).toStrictEqual({});
  });
});

describe("validateSleepInventory", () => {
  test("accepts a fully inventoried population at budget", () => {
    const { errors, count } = validateSleepInventory(
      { _budget: 3, sites: { "a.test.ts": 2, "b.test.ts": 1 } },
      { "a.test.ts": 2, "b.test.ts": 1 }
    );
    expect(errors).toStrictEqual([]);
    expect(count).toBe(3);
  });

  test("an uninventoried sleep fails with the remedy", () => {
    const { errors } = validateSleepInventory(
      { _budget: 0, sites: {} },
      { "a.test.ts": 1 }
    );
    expect(errors.join("\n")).toContain("uninventoried fixed sleep(s)");
    expect(errors.join("\n")).toContain("useFakeClock()");
  });

  test("a file that grew fails even inside a slack total", () => {
    // b shrank while a grew: the per-file counts catch the move that a bare
    // total would launder.
    const { errors } = validateSleepInventory(
      { _budget: 4, sites: { "a.test.ts": 1, "b.test.ts": 3 } },
      { "a.test.ts": 2, "b.test.ts": 2 }
    );
    expect(errors.join("\n")).toContain(
      "a.test.ts grew from 1 to 2 fixed sleep site(s)"
    );
    expect(errors.join("\n")).toContain("b.test.ts is down to 2");
  });

  test("the budget is down-only in both directions", () => {
    const over = validateSleepInventory(
      { _budget: 1, sites: { "a.test.ts": 1, "b.test.ts": 1 } },
      { "a.test.ts": 1, "b.test.ts": 1 }
    );
    expect(over.errors.join("\n")).toContain("fixed-sleep budget exceeded");
    expect(over.errors.join("\n")).toContain("Top offenders");
    const slack = validateSleepInventory(
      { _budget: 5, sites: { "a.test.ts": 1 } },
      { "a.test.ts": 1 }
    );
    expect(slack.errors.join("\n")).toContain("Ratchet _budget down to 1");
  });

  test("an entry whose file no longer has sleeps fails instead of rotting", () => {
    const { errors } = validateSleepInventory(
      { _budget: 0, sites: { "gone.test.ts": 2 } },
      {}
    );
    expect(errors.join("\n")).toContain("stale sleep inventory entry");
  });

  test("a missing or non-integer budget fails", () => {
    const { errors } = validateSleepInventory({ sites: {} }, {});
    expect(errors.join("\n")).toContain("no integer _budget");
  });
});

describe("reconcileInventory", () => {
  test("refreshes counts, drops vanished files, and never raises the budget", () => {
    const next = reconcileInventory(
      { _budget: 9, sites: { "a.test.ts": 2, "gone.test.ts": 3 } },
      { "a.test.ts": 2, "b.test.ts": 1 }
    );
    expect(next.sites).toStrictEqual({ "a.test.ts": 2, "b.test.ts": 1 });
    // 9 was slack against a measured 3 — --write can only LOWER it.
    expect(next._budget).toBe(3);
    const unseeded = reconcileInventory({}, { "a.test.ts": 1 });
    expect(unseeded._budget).toBe(1);
  });
});

describe("topOffenders", () => {
  test("orders by count then path and formats hygiene-ratchet style", () => {
    const offenders = topOffenders(
      { "b.test.ts": 2, "a.test.ts": 2, "c.test.ts": 5 },
      2
    );
    expect(offenders).toStrictEqual(["c.test.ts (5)", "a.test.ts (2)"]);
    expect(totalSites({ "a.test.ts": 2, "c.test.ts": 5 })).toBe(7);
  });
});
