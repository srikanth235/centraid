import { describe, expect, test } from "vitest";

import {
  REQUIRED_RESOURCE_LANES,
  RESOURCE_LEDGER_SCHEMA_VERSION,
  validateResourceLedger,
  withinTolerance,
} from "./resource-evidence.js";
import type {
  ResourceLedger,
  ResourceObservation,
} from "./resource-evidence.js";

const blocked = (
  overrides: Partial<ResourceObservation> = {}
): ResourceObservation => ({
  id: "ios-battery",
  surface: "ios",
  metric: "battery-drain-pct-per-hour",
  method: "blocked-external",
  value: null,
  unit: "%/h",
  device: { model: "unknown", os: "unknown", class: "phone-current" },
  at: "2026-08-21",
  evidence: "https://github.com/srikanth235/centraid/issues/842",
  blockedReason: "no physical device in CI",
  unblockCondition: "an enrolled iPhone on the nightly device lane",
  ...overrides,
});

const derived = (
  overrides: Partial<ResourceObservation> = {}
): ResourceObservation => ({
  id: "host-vault-bytes",
  surface: "host-proxy",
  metric: "vault-bytes-per-1k-items",
  method: "derived",
  value: 1000,
  unit: "bytes/1k items",
  device: { model: "ci-linux-x64", os: "linux", class: "host-proxy" },
  at: "2026-08-21",
  evidence: "tests/quality/mobile-resource-evidence.test.ts",
  recomputedBy: "tests/quality/mobile-resource-evidence.test.ts",
  tolerance: 0.25,
  ...overrides,
});

function ledgerOf(rows: ResourceObservation[]): ResourceLedger {
  return {
    schemaVersion: RESOURCE_LEDGER_SCHEMA_VERSION,
    observations: rows,
  };
}

function fullLanes(extra: ResourceObservation[] = []): ResourceObservation[] {
  return [
    ...REQUIRED_RESOURCE_LANES.map(([surface, metric], index) =>
      surface === "host-proxy"
        ? derived({ id: `lane-${index}`, surface, metric })
        : blocked({ id: `lane-${index}`, surface, metric })
    ),
    ...extra,
  ];
}

describe("resource-ledger validation", () => {
  test("a complete ledger of blocked and derived rows validates", () => {
    const result = validateResourceLedger(ledgerOf(fullLanes()));
    expect(result.errors).toStrictEqual([]);
    expect(result.blocked).toHaveLength(6);
    expect(result.recorded).toHaveLength(3);
  });

  test("a lane with no row at all is an error — never silently absent", () => {
    const rows = fullLanes().filter((row) => row.metric !== "cold-start-ms");
    const result = validateResourceLedger(ledgerOf(rows));
    expect(result.errors).toContain(
      "lane ios/cold-start-ms has no row — a lane is measured or blocked-with-a-reason, never absent"
    );
    expect(result.errors).toContain(
      "lane android/cold-start-ms has no row — a lane is measured or blocked-with-a-reason, never absent"
    );
  });

  test("a blocked row must say why and what unblocks it", () => {
    const result = validateResourceLedger(
      ledgerOf(
        fullLanes([
          blocked({
            id: "vague",
            blockedReason: undefined,
            unblockCondition: undefined,
          }),
        ])
      )
    );
    expect(result.errors).toContain(
      "vague: blocked-external needs blockedReason"
    );
    expect(result.errors).toContain(
      "vague: blocked-external needs unblockCondition"
    );
  });

  test("a blocked row may not smuggle a number in", () => {
    const result = validateResourceLedger(
      ledgerOf(fullLanes([blocked({ id: "sneaky", value: 4.2 })]))
    );
    expect(result.errors).toContain(
      "sneaky: a blocked-external row must carry value: null"
    );
  });

  test("a measured or derived row must be re-derivable", () => {
    const result = validateResourceLedger(
      ledgerOf(
        fullLanes([
          derived({
            id: "loose",
            recomputedBy: undefined,
            tolerance: undefined,
          }),
        ])
      )
    );
    expect(result.errors).toContain(
      "loose: derived needs recomputedBy naming the test that reproduces it"
    );
    expect(result.errors).toContain(
      "loose: derived needs a positive tolerance"
    );
  });

  test("a derived row may not claim to be a device measurement, and vice versa", () => {
    const result = validateResourceLedger(
      ledgerOf(
        fullLanes([
          derived({
            id: "pretender",
            device: {
              model: "iPhone 15",
              os: "iOS 26",
              class: "phone-current",
            },
          }),
          derived({
            id: "mislabelled",
            method: "measured",
            device: { model: "ci", os: "linux", class: "host-proxy" },
          }),
        ])
      )
    );
    expect(result.errors).toContain(
      "pretender: a derived row is a host proxy and may not claim a device class"
    );
    expect(result.errors).toContain(
      "mislabelled: a measured row on a host proxy is derived, not measured"
    );
  });

  test("duplicate ids and a wrong schema version are refused", () => {
    const rows = fullLanes([derived({ id: "dupe" }), derived({ id: "dupe" })]);
    const result = validateResourceLedger({
      schemaVersion: 99,
      observations: rows,
    });
    expect(result.errors).toContain("dupe: duplicate id");
    expect(result.errors).toContain("schemaVersion 99 != 1");
  });
});

describe("tolerance bands", () => {
  test("accepts inside the band and refuses outside it", () => {
    const row = derived({ value: 100, tolerance: 0.2 });
    expect(withinTolerance(row, 118)).toBe(true);
    expect(withinTolerance(row, 82)).toBe(true);
    expect(withinTolerance(row, 121)).toBe(false);
    expect(withinTolerance(row, 79)).toBe(false);
  });

  test("a row with no value can never be satisfied by a measurement", () => {
    expect(withinTolerance(blocked(), 0)).toBe(false);
  });
});
