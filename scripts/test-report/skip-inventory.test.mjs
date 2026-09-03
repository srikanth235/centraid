import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import {
  SCAN_EXCLUDE,
  SCAN_INCLUDE,
  SKIP_PATTERNS,
  discoverSkipSites,
  reconcileInventory,
  scanSkipSites,
  validateSkipInventory,
} from "./skip-inventory.mjs";

const trackingIssues = {
  656: { url: "https://example.test/656", state: "open" },
  470: { url: "https://example.test/470", state: "closed" },
};

const site = (key, overrides = {}) => ({
  key,
  file: key.split("#")[0],
  ordinal: Number(key.split("#")[1]),
  line: 10,
  kind: "static-skip",
  snippet: "test.skip(...)",
  ...overrides,
});

const entry = (overrides = {}) => ({
  kind: "static-skip",
  line: 10,
  issue: 656,
  reason: "an honest sentence naming what cannot run",
  ...overrides,
});

describe("scanSkipSites", () => {
  test("finds every skip shape and keys them by ordinal, not line", () => {
    const source = [
      "test.skip('a', () => {});",
      "describe.skipIf(flag)('b', () => {});",
      "it.todo('c');",
      "  t.skip('platform only');",
      'if (process.env.CENTRAID_DISKFULL_E2E !== "1") {',
    ].join("\n");
    const sites = scanSkipSites("packages/x/src/a.test.ts", source);
    expect(sites.map((found) => found.kind)).toEqual([
      "static-skip",
      "conditional-skip",
      "todo",
      "runtime-skip",
      "env-gate",
    ]);
    expect(sites.map((found) => found.key)).toEqual([
      "packages/x/src/a.test.ts#1",
      "packages/x/src/a.test.ts#2",
      "packages/x/src/a.test.ts#3",
      "packages/x/src/a.test.ts#4",
      "packages/x/src/a.test.ts#5",
    ]);
    expect(sites[4].line).toBe(5);
  });

  test("a diagnostic env read is not a hole in the suite", () => {
    const gate = 'const strict = process.env.CENTRAID_PERF_EVIDENCE === "1";';
    const log =
      'if (process.env.CENTRAID_PERF_EVIDENCE === "1") console.info(1);';
    expect(scanSkipSites("a.test.ts", gate)).toHaveLength(1);
    expect(scanSkipSites("a.test.ts", log)).toHaveLength(0);
  });

  test("scan configuration excludes the detectors' own fixtures", () => {
    expect(SCAN_EXCLUDE).toContain("scripts/test-report/");
    expect(SCAN_INCLUDE.some((pattern) => pattern.startsWith("tests/"))).toBe(
      true
    );
    expect(SKIP_PATTERNS.every((detector) => detector.pattern.source)).toBe(
      true
    );
  });
});

describe("discoverSkipSites", () => {
  function writeFixture(root, file, source) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, source);
  }

  test("scans script tests in NESTED directories, not just the top level", async () => {
    const root = tempDirSync("skip-inventory-");
    writeFixture(root, "scripts/top.test.mjs", "test.skip('top', () => {});");
    writeFixture(
      root,
      "scripts/gateway-package/nested.test.mjs",
      "test('x', (t) => {\n  t.skip('dist missing');\n});"
    );
    writeFixture(
      root,
      "apps/mobile/scripts/nested.test.mjs",
      "it.todo('mobile script');"
    );
    const sites = await discoverSkipSites({ root });
    expect(sites.map((found) => found.key).sort()).toEqual([
      "apps/mobile/scripts/nested.test.mjs#1",
      "scripts/gateway-package/nested.test.mjs#1",
      "scripts/top.test.mjs#1",
    ]);
  });

  test("still exempts the detectors' own fixtures under scripts/test-report", async () => {
    const root = tempDirSync("skip-inventory-");
    writeFixture(
      root,
      "scripts/test-report/detector.test.mjs",
      "test.skip('quoted fixture', () => {});"
    );
    expect(await discoverSkipSites({ root })).toEqual([]);
  });
});

describe("validateSkipInventory", () => {
  test("accepts a fully inventoried population at budget", () => {
    const { errors, count } = validateSkipInventory(
      { _budget: 1, sites: { "a.test.ts#1": entry() } },
      [site("a.test.ts#1")],
      { trackingIssues }
    );
    expect(errors).toEqual([]);
    expect(count).toBe(1);
  });

  test("an uninventoried skip fails", () => {
    const { errors } = validateSkipInventory(
      { _budget: 1, sites: {} },
      [site("a.test.ts#1")],
      { trackingIssues }
    );
    expect(errors.join("\n")).toContain("uninventoried skip a.test.ts#1");
  });

  test("a skip citing a closed or unregistered issue fails", () => {
    const closed = validateSkipInventory(
      { _budget: 1, sites: { "a.test.ts#1": entry({ issue: 470 }) } },
      [site("a.test.ts#1")],
      { trackingIssues }
    );
    expect(closed.errors.join("\n")).toContain("cites closed issue #470");
    const unknown = validateSkipInventory(
      { _budget: 1, sites: { "a.test.ts#1": entry({ issue: 999 }) } },
      [site("a.test.ts#1")],
      { trackingIssues }
    );
    expect(unknown.errors.join("\n")).toContain("not registered");
  });

  test("a reason that says nothing fails", () => {
    const { errors } = validateSkipInventory(
      { _budget: 1, sites: { "a.test.ts#1": entry({ reason: "flaky" }) } },
      [site("a.test.ts#1")],
      { trackingIssues }
    );
    expect(errors.join("\n")).toContain("no usable reason");
  });

  test("the budget is down-only in both directions", () => {
    const over = validateSkipInventory(
      {
        _budget: 1,
        sites: { "a.test.ts#1": entry(), "b.test.ts#1": entry() },
      },
      [site("a.test.ts#1"), site("b.test.ts#1")],
      { trackingIssues }
    );
    expect(over.errors.join("\n")).toContain("skip budget exceeded");
    const slack = validateSkipInventory(
      { _budget: 5, sites: { "a.test.ts#1": entry() } },
      [site("a.test.ts#1")],
      { trackingIssues }
    );
    expect(slack.errors.join("\n")).toContain("Ratchet _budget down to 1");
  });

  test("an entry whose skip is gone fails instead of rotting", () => {
    const { errors } = validateSkipInventory(
      { _budget: 0, sites: { "a.test.ts#1": entry() } },
      [],
      { trackingIssues }
    );
    expect(errors.join("\n")).toContain("stale skip inventory entry");
  });

  test("line drift is a warning, not a merge blocker", () => {
    const { errors, warnings } = validateSkipInventory(
      { _budget: 1, sites: { "a.test.ts#1": entry({ line: 3 }) } },
      [site("a.test.ts#1")],
      { trackingIssues }
    );
    expect(errors).toEqual([]);
    expect(warnings.join("\n")).toContain("moved from line 3 to 10");
  });
});

describe("reconcileInventory", () => {
  test("keeps citations, drops vanished sites, and never raises the budget", () => {
    const next = reconcileInventory(
      {
        _budget: 4,
        sites: { "a.test.ts#1": entry({ line: 3 }), "gone.test.ts#1": entry() },
      },
      [site("a.test.ts#1"), site("b.test.ts#1")]
    );
    expect(Object.keys(next.sites)).toEqual(["a.test.ts#1", "b.test.ts#1"]);
    expect(next.sites["a.test.ts#1"].issue).toBe(656);
    expect(next.sites["a.test.ts#1"].line).toBe(10);
    expect(next.sites["b.test.ts#1"].issue).toBeNull();
    expect(next._budget).toBe(2);
  });
});
