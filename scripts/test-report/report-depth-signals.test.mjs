import { describe, expect, test } from "vitest";

import {
  calculateFlakeRates,
  collectLaneSeries,
  filterFloorConfigEntries,
  findAbsoluteWeaknesses,
  mergeLaneMarkers,
  scopeMatcher,
} from "./report-depth-signals.mjs";
import { validateMatrix } from "./validate-matrix.mjs";

describe("durable depth signals", () => {
  test("persists every perf/scale measurement by stable owner and name", () => {
    expect(
      collectLaneSeries([
        {
          owner: "tests/perf/x.test.ts",
          lane: "perf",
          measurements: [
            { name: "p95", value: 12, unit: "ms", budget: 30 },
            { name: "rss", value: 4, unit: "MiB" },
          ],
        },
      ])
    ).toEqual({
      "tests/perf/x.test.ts::p95": {
        owner: "tests/perf/x.test.ts",
        name: "p95",
        lane: "perf",
        value: 12,
        unit: "ms",
        budget: 30,
      },
      "tests/perf/x.test.ts::rss": {
        owner: "tests/perf/x.test.ts",
        name: "rss",
        lane: "perf",
        value: 4,
        unit: "MiB",
        budget: null,
      },
    });
  });

  test("calculates owner flake rate across durable and current classifications", () => {
    expect(
      calculateFlakeRates(
        [{ owner: "a.spec.ts", source: "playwright", status: "flaky" }],
        [
          {
            playwrightOwnerIds: ["a.spec.ts"],
            flakyOwnerIds: [],
          },
        ]
      )
    ).toEqual([{ owner: "a.spec.ts", runs: 2, flaky: 1, rate: 50 }]);
  });

  test("flags weak mutation and floors far below measured coverage", () => {
    expect(
      findAbsoluteWeaknesses(
        [{ scope: "client", lines: 76, lineFloor: 45 }],
        [{ scope: "backup", score: 44.5, floor: 40 }]
      )
    ).toEqual([
      {
        kind: "coverage-floor-lag",
        scope: "client",
        value: 76,
        floor: 45,
      },
      {
        kind: "weak-mutation",
        scope: "backup",
        value: 44.5,
        floor: 40,
      },
    ]);
  });

  test("flags branch floor lag and honors configured thresholds", () => {
    expect(
      findAbsoluteWeaknesses(
        [
          {
            scope: "oauth-worker",
            lines: 90,
            lineFloor: 88,
            branches: 84,
            branchFloor: 55,
          },
        ],
        [{ scope: "gateway", score: 58, floor: 55 }],
        { coverageHeadroom: 15, mutationMinimum: 60 }
      )
    ).toEqual([
      {
        kind: "coverage-floor-lag",
        scope: "oauth-worker (branches)",
        value: 84,
        floor: 55,
      },
      {
        kind: "weak-mutation",
        scope: "gateway",
        value: 58,
        floor: 55,
      },
    ]);
  });
});

describe("filterFloorConfigEntries", () => {
  test("drops _comment and non-scope meta keys", () => {
    const entries = filterFloorConfigEntries({
      _comment: "seed floors",
      approvedDeviation: { reason: "x" },
      lines: 70,
      "packages/server/**": { lines: 80 },
    });
    expect(entries.map(([k]) => k).sort()).toEqual([
      "lines",
      "packages/server/**",
    ]);
  });
});

describe("scopeMatcher", () => {
  test("`*` stays inside one path segment so sibling trees keep their own floor", () => {
    const match = scopeMatcher("packages/client/src/*.{ts,tsx}");
    expect(match("packages/client/src/gateway-client-atlas.ts")).toBe(true);
    expect(match("packages/client/src/core.tsx")).toBe(true);
    expect(match("packages/client/src/react/HomeRoute.tsx")).toBe(false);
    expect(match("packages/client/src/replica/store.ts")).toBe(false);
  });

  test("`**` crosses segments and also matches zero of them", () => {
    const match = scopeMatcher("packages/server/src/**");
    expect(match("packages/server/src/serve/vault-plane-wal.test.ts")).toBe(
      true
    );
    expect(match("packages/server/src/index.ts")).toBe(true);
    expect(match("packages/vault/src/index.ts")).toBe(false);
  });

  test("a suffix glob selects only the files that carry the suffix", () => {
    const match = scopeMatcher("apps/desktop/src/main/*-core.ts");
    expect(match("apps/desktop/src/main/preload-core.ts")).toBe(true);
    expect(match("apps/desktop/src/main/settings.ts")).toBe(false);
    expect(match("apps/desktop/src/main/nested/x-core.ts")).toBe(false);
  });

  test("dots are literal, not wildcards", () => {
    const match = scopeMatcher("packages/core/src/protocol/**");
    expect(match("packagesXprotocol/src/a.ts")).toBe(false);
  });
});

describe("mergeLaneMarkers", () => {
  test("merges per-lane shards without last-write-win loss", () => {
    expect(
      mergeLaneMarkers([
        { "desktop-playwright": "2026-07-24T01:00:00.000Z" },
        { "web-playwright": "2026-07-24T02:00:00.000Z" },
        { "desktop-playwright": "2026-07-24T03:00:00.000Z" },
      ])
    ).toEqual({
      "desktop-playwright": "2026-07-24T03:00:00.000Z",
      "web-playwright": "2026-07-24T02:00:00.000Z",
    });
  });
});

describe("validateMatrix skip notes (#535)", () => {
  test("fails when a skip cell has no matrix.notes rationale", async () => {
    const matrix = {
      dimensions: [{ id: "journey", label: "Journey", lane: "e2e" }],
      surfaces: [
        { id: "mobile", label: "Mobile", assessment: { journey: "skip" } },
      ],
      cellOwners: { "mobile.journey": null },
      flows: [],
      notes: {},
    };
    const { errors } = await validateMatrix(matrix, { checkFiles: false });
    expect(
      errors.some(
        (error) =>
          error.includes("mobile.journey") && error.includes("matrix.notes")
      )
    ).toBe(true);
  });

  test("accepts a skip cell with a one-line note", async () => {
    const matrix = {
      dimensions: [{ id: "journey", label: "Journey", lane: "e2e" }],
      surfaces: [
        { id: "mobile", label: "Mobile", assessment: { journey: "skip" } },
      ],
      cellOwners: { "mobile.journey": null },
      flows: [],
      notes: {
        "mobile.journey":
          "Delegated to consuming surface; no native journey surface.",
      },
    };
    const { errors } = await validateMatrix(matrix, { checkFiles: false });
    expect(errors.filter((error) => error.includes("matrix.notes"))).toEqual(
      []
    );
  });

  test("requires a live structured tracking issue for every gap", async () => {
    const matrix = {
      dimensions: [{ id: "performance", label: "Performance", lane: "perf" }],
      surfaces: [
        {
          id: "backup",
          label: "Backup",
          assessment: { performance: "gap" },
        },
      ],
      cellOwners: { "backup.performance": null },
      flows: [],
      gaps: { "backup.performance": { trackingIssue: 545 } },
      trackingIssues: {
        545: { state: "closed", url: "https://example.test/issues/545" },
      },
    };
    const { errors } = await validateMatrix(matrix, { checkFiles: false });
    expect(errors).toContain(
      "backup.performance gap references closed tracking issue #545"
    );
  });

  test("rejects generic partial boilerplate", async () => {
    const matrix = {
      dimensions: [{ id: "security", label: "Security", lane: "unit" }],
      surfaces: [
        {
          id: "web",
          label: "Web",
          assessment: { security: "partial" },
        },
      ],
      cellOwners: {
        "web.security": { owner: "x.test.ts", tier: "unit" },
      },
      flows: [],
      notes: {
        "web.security":
          "web.security has some owning proof but is incomplete or not continuously exercised.",
      },
    };
    const { errors } = await validateMatrix(matrix, { checkFiles: false });
    expect(errors.some((error) => error.includes("rejected boilerplate"))).toBe(
      true
    );
  });
});
