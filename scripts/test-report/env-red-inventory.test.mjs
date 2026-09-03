import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import {
  ENV_GUARD_PATTERNS,
  GUARD_MECHANISMS,
  discoverEnvGuardSites,
  reconcileInventory,
  scanEnvGuardSites,
  validateEnvRedInventory,
} from "./env-red-inventory.mjs";

const trackingIssues = {
  781: { url: "https://example.test/781", state: "open" },
  656: { url: "https://example.test/656", state: "closed" },
};

const NOW = Date.parse("2026-08-15T00:00:00Z");

const GUARDED_SOURCE = [
  "test.skipIf(process.platform !== 'darwin')(",
  "  'the base clone is a reflink',",
  "  () => {}",
  ");",
].join("\n");

const site = (key, overrides = {}) => ({
  key,
  file: key.split("#")[0],
  ordinal: Number(key.split("#")[1]),
  line: 1,
  kind: "platform-guard",
  snippet: "test.skipIf(process.platform !== 'darwin')(",
  ...overrides,
});

const entry = (overrides = {}) => ({
  kind: "platform-guard",
  line: 1,
  test: "the base clone is a reflink",
  environment: "red off darwin: ext4 cannot reflink, APFS can",
  guard: "skipIf",
  issue: 781,
  revisitTrigger: "revisit if CI gains a reflink-capable linux runner",
  ...overrides,
});

const doc = (sites) => ({ _budget: Object.keys(sites).length, sites });

describe("scanEnvGuardSites", () => {
  test("finds platform, arch, and uid comparison guards, keyed by ordinal", () => {
    const source = [
      "test.skipIf(process.platform !== 'darwin')('a', () => {});",
      "const onArm = process.arch === 'arm64';",
      "if (process.getuid?.() === 0) t.skip('red as root');",
      "if (0 === process.geteuid()) t.skip('reversed operands');",
    ].join("\n");
    const sites = scanEnvGuardSites("packages/x/src/a.test.ts", source);
    expect(sites.map((found) => found.kind)).toEqual([
      "platform-guard",
      "arch-guard",
      "uid-guard",
      "uid-guard",
    ]);
    expect(sites.map((found) => found.key)).toEqual([
      "packages/x/src/a.test.ts#1",
      "packages/x/src/a.test.ts#2",
      "packages/x/src/a.test.ts#3",
      "packages/x/src/a.test.ts#4",
    ]);
    expect(sites[3].line).toBe(4);
  });

  test("non-comparison environment reads are not guards", () => {
    const source = [
      "results.push({ platform: process.platform });",
      "expect(bundle.runtime.platform).toBe(os.platform());",
      "process.geteuid = () => 0; // pretend we are root",
      "const originalGeteuid = process.geteuid;",
    ].join("\n");
    expect(scanEnvGuardSites("a.test.ts", source)).toEqual([]);
  });

  test("detector metadata is well-formed", () => {
    expect(ENV_GUARD_PATTERNS.every((d) => d.pattern.source.length > 0)).toBe(
      true
    );
    expect(GUARD_MECHANISMS.has("skipIf")).toBe(true);
    expect(GUARD_MECHANISMS.has("quarantine")).toBe(false);
  });
});

describe("discoverEnvGuardSites", () => {
  function writeFixture(root, file, source) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, source);
  }

  test("scans the skip-inventory globs and returns sources for guarded files", async () => {
    const root = tempDirSync("env-red-");
    writeFixture(root, "packages/x/src/a.test.ts", GUARDED_SOURCE);
    writeFixture(root, "packages/x/src/clean.test.ts", "test('y', () => {});");
    writeFixture(
      root,
      "scripts/gateway-package/nested.test.mjs",
      "if (process.platform !== 'darwin') t.skip('darwin only');"
    );
    const { sites, sources } = await discoverEnvGuardSites({ root });
    expect(sites.map((found) => found.key)).toEqual([
      "packages/x/src/a.test.ts#1",
      "scripts/gateway-package/nested.test.mjs#1",
    ]);
    expect(Object.keys(sources)).toEqual([
      "packages/x/src/a.test.ts",
      "scripts/gateway-package/nested.test.mjs",
    ]);
  });

  test("exempts the detectors' own fixtures under scripts/test-report", async () => {
    const root = tempDirSync("env-red-");
    writeFixture(root, "scripts/test-report/detector.test.mjs", GUARDED_SOURCE);
    const { sites } = await discoverEnvGuardSites({ root });
    expect(sites).toEqual([]);
  });
});

describe("validateEnvRedInventory", () => {
  const key = "a.test.ts#1";
  const sources = { "a.test.ts": GUARDED_SOURCE };

  test("accepts a fully documented population at budget", () => {
    const { errors, count } = validateEnvRedInventory(
      doc({ [key]: entry() }),
      [site(key)],
      { trackingIssues, sources, nowMs: NOW }
    );
    expect(errors).toEqual([]);
    expect(count).toBe(1);
  });

  test("an uninventoried env guard fails", () => {
    const { errors } = validateEnvRedInventory(doc({}), [site(key)], {
      trackingIssues,
      sources,
      nowMs: NOW,
    });
    expect(errors.join("\n")).toContain(`uninventoried env guard ${key}`);
  });

  test("an entry whose guard or file is gone fails instead of rotting", () => {
    const { errors } = validateEnvRedInventory(doc({ [key]: entry() }), [], {
      trackingIssues,
      sources: {},
      nowMs: NOW,
    });
    expect(errors.join("\n")).toContain(`stale env-red entry ${key}`);
  });

  test("an entry whose guarded test vanished from the file fails", () => {
    const { errors } = validateEnvRedInventory(
      doc({ [key]: entry({ test: "a test title nobody has" }) }),
      [site(key)],
      { trackingIssues, sources, nowMs: NOW }
    );
    expect(errors.join("\n")).toContain(
      `test "a test title nobody has" no longer exists in a.test.ts`
    );
  });

  test("a declared guard the file does not actually contain fails", () => {
    const { errors } = validateEnvRedInventory(
      doc({ [key]: entry({ guard: "runtime-skip" }) }),
      [site(key)],
      { trackingIssues, sources, nowMs: NOW }
    );
    expect(errors.join("\n")).toContain("naked-red in its environment");
  });

  test("an unknown guard mechanism fails", () => {
    const { errors } = validateEnvRedInventory(
      doc({ [key]: entry({ guard: "quarantine" }) }),
      [site(key)],
      { trackingIssues, sources, nowMs: NOW }
    );
    expect(errors.join("\n")).toContain("needs `guard` — one of");
  });

  test("a missing, unregistered, or closed issue fails", () => {
    const missing = validateEnvRedInventory(
      doc({ [key]: entry({ issue: null }) }),
      [site(key)],
      { trackingIssues, sources, nowMs: NOW }
    );
    expect(missing.errors.join("\n")).toContain("cites no tracking issue");
    const unknown = validateEnvRedInventory(
      doc({ [key]: entry({ issue: 999 }) }),
      [site(key)],
      { trackingIssues, sources, nowMs: NOW }
    );
    expect(unknown.errors.join("\n")).toContain("not registered");
    const closed = validateEnvRedInventory(
      doc({ [key]: entry({ issue: 656 }) }),
      [site(key)],
      { trackingIssues, sources, nowMs: NOW }
    );
    expect(closed.errors.join("\n")).toContain("cites closed issue #656");
  });

  test("an environment sentence that says nothing fails", () => {
    const { errors } = validateEnvRedInventory(
      doc({ [key]: entry({ environment: "darwin" }) }),
      [site(key)],
      { trackingIssues, sources, nowMs: NOW }
    );
    expect(errors.join("\n")).toContain("no usable `environment`");
  });

  test("an entry with neither expiry nor revisit trigger fails", () => {
    const { errors } = validateEnvRedInventory(
      doc({ [key]: entry({ revisitTrigger: "" }) }),
      [site(key)],
      { trackingIssues, sources, nowMs: NOW }
    );
    expect(errors.join("\n")).toContain(
      "needs an `expiresAt` date or a `revisitTrigger` sentence"
    );
  });

  test("expiry is a hard boundary: expired fails, the future passes", () => {
    const expired = validateEnvRedInventory(
      doc({
        [key]: entry({ revisitTrigger: "", expiresAt: "2026-08-15" }),
      }),
      [site(key)],
      { trackingIssues, sources, nowMs: NOW }
    );
    expect(expired.errors.join("\n")).toContain("EXPIRED on 2026-08-15");
    const future = validateEnvRedInventory(
      doc({
        [key]: entry({ revisitTrigger: "", expiresAt: "2026-08-16" }),
      }),
      [site(key)],
      { trackingIssues, sources, nowMs: NOW }
    );
    expect(future.errors).toEqual([]);
    const garbled = validateEnvRedInventory(
      doc({ [key]: entry({ expiresAt: "someday" }) }),
      [site(key)],
      { trackingIssues, sources, nowMs: NOW }
    );
    expect(garbled.errors.join("\n")).toContain("must be YYYY-MM-DD");
  });

  test("the budget is down-only in both directions", () => {
    const over = validateEnvRedInventory(
      { _budget: 1, sites: { [key]: entry(), "b.test.ts#1": entry() } },
      [site(key), site("b.test.ts#1")],
      {
        trackingIssues,
        sources: { ...sources, "b.test.ts": GUARDED_SOURCE },
        nowMs: NOW,
      }
    );
    expect(over.errors.join("\n")).toContain("env-red budget exceeded");
    const slack = validateEnvRedInventory(
      { _budget: 5, sites: { [key]: entry() } },
      [site(key)],
      { trackingIssues, sources, nowMs: NOW }
    );
    expect(slack.errors.join("\n")).toContain("Ratchet _budget down to 1");
  });

  test("a kind mismatch fails and line drift only warns", () => {
    const mismatch = validateEnvRedInventory(
      doc({ [key]: entry({ kind: "uid-guard" }) }),
      [site(key)],
      { trackingIssues, sources, nowMs: NOW }
    );
    expect(mismatch.errors.join("\n")).toContain(
      "inventoried as uid-guard but is now platform-guard"
    );
    const drift = validateEnvRedInventory(
      doc({ [key]: entry({ line: 7 }) }),
      [site(key)],
      { trackingIssues, sources, nowMs: NOW }
    );
    expect(drift.errors).toEqual([]);
    expect(drift.warnings.join("\n")).toContain("moved from line 7 to 1");
  });
});

describe("reconcileInventory", () => {
  test("keeps documentation, drops vanished sites, and never raises the budget", () => {
    const next = reconcileInventory(
      {
        _budget: 4,
        sites: { "a.test.ts#1": entry({ line: 7 }), "gone.test.ts#1": entry() },
      },
      [site("a.test.ts#1"), site("b.test.ts#1")]
    );
    expect(Object.keys(next.sites)).toEqual(["a.test.ts#1", "b.test.ts#1"]);
    expect(next.sites["a.test.ts#1"].issue).toBe(781);
    expect(next.sites["a.test.ts#1"].line).toBe(1);
    expect(next.sites["b.test.ts#1"].issue).toBeNull();
    expect(next.sites["b.test.ts#1"].guard).toBeNull();
    expect(next._budget).toBe(2);
  });
});
