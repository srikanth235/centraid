import { describe, expect, test } from "vitest";

import {
  agedInfraMismatches,
  cellIdentityRegressions,
  cellsMissingRatchet,
  collectPlaywrightEvidence,
  detectDefaultCiEnvGate,
  extractUnhandledErrors,
  findUnmatchedOwners,
  findUnmappedEvidence,
  reconcileJobConclusions,
  resolvePlaywrightOwner,
  summarizeCellStates,
  sustainedRatchetCandidates,
} from "./report-signals.mjs";
import {
  REPORT_COMMENT_MARKER,
  coverageScopesBelowFloor,
  publicReportUrl,
  renderSummaryMarkdown,
} from "./summary-markdown.mjs";

describe("extractUnhandledErrors", () => {
  test("reads explicit unhandledErrors array from vitest JSON", () => {
    const messages = extractUnhandledErrors({
      success: false,
      unhandledErrors: [{ message: "write EPIPE" }, "other"],
      testResults: [
        {
          status: "passed",
          assertionResults: [{ status: "passed" }],
        },
      ],
    });
    expect(messages).toContain("write EPIPE");
    expect(messages).toContain("other");
  });

  test("flags success=false with zero failed tests (EPIPE-class process fail)", () => {
    const messages = extractUnhandledErrors({
      success: false,
      testResults: [
        {
          status: "passed",
          assertionResults: [{ status: "passed" }, { status: "passed" }],
        },
      ],
    });
    expect(messages.some((m) => /success=false|unhandled/iu.test(m))).toBe(
      true
    );
  });

  test("does not invent errors when suite genuinely failed assertions", () => {
    const messages = extractUnhandledErrors({
      success: false,
      testResults: [
        {
          status: "failed",
          assertionResults: [{ status: "failed", fullName: "x" }],
        },
      ],
    });
    expect(messages.every((m) => !/zero failed tests/iu.test(m))).toBe(true);
  });
});

describe("durable floor and infrastructure ratchets", () => {
  test("proposes a floor only after the candidate is sustained for three runs", () => {
    const history = [
      { floorSeries: { "coverage:repo-wide:lines": 80 } },
      { floorSeries: { "coverage:repo-wide:lines": 81 } },
    ];
    expect(
      sustainedRatchetCandidates(
        { "coverage:repo-wide:lines": 82 },
        history,
        { "coverage:repo-wide:lines": 71 },
        { sustainedRuns: 3, marginPoints: 2 }
      )
    ).toEqual([
      {
        key: "coverage:repo-wide:lines",
        floor: 71,
        candidate: 78,
        values: [80, 81, 82],
      },
    ]);
    expect(
      sustainedRatchetCandidates(
        { "coverage:repo-wide:lines": 82 },
        history.slice(1),
        { "coverage:repo-wide:lines": 71 },
        { sustainedRuns: 3, marginPoints: 2 }
      )
    ).toEqual([]);
  });

  test("alarms when the same infra mismatch occupies three consecutive runs", () => {
    expect(
      agedInfraMismatches(
        ["mobile:journey"],
        [
          { infraMismatchCellIds: ["mobile:journey"] },
          { infraMismatchCellIds: ["mobile:journey"] },
        ],
        { maxConsecutiveRuns: 3 }
      )
    ).toEqual(["mobile:journey"]);
  });
});

describe("summarizeCellStates", () => {
  test("separates failed from missing (lane ran vs not run)", () => {
    const counts = summarizeCellStates([
      { state: "passed" },
      { state: "failed" },
      { state: "failed" },
      { state: "missing" },
      { state: "missing" },
      { state: "missing" },
      { state: "skipped" },
    ]);
    expect(counts.cellsFailed).toBe(2);
    expect(counts.cellsMissing).toBe(3);
    expect(counts.cellsPassed).toBe(1);
    expect(counts.cellsSkipped).toBe(1);
  });
});

describe("Playwright evidence", () => {
  test("resolves bare suite basenames against Playwright config.rootDir", () => {
    expect(
      resolvePlaywrightOwner("web-pwa.spec.ts", {
        repoRoot: "/repo",
        configRoot: "/repo/apps/web/tests/e2e",
        registeredOwners: ["apps/web/tests/e2e/web-pwa.spec.ts"],
      })
    ).toBe("apps/web/tests/e2e/web-pwa.spec.ts");
  });

  test("falls back to a unique registered suffix when rootDir is unavailable", () => {
    expect(
      resolvePlaywrightOwner("web-pwa.spec.ts", {
        registeredOwners: ["apps/web/tests/e2e/web-pwa.spec.ts"],
      })
    ).toBe("apps/web/tests/e2e/web-pwa.spec.ts");
  });

  test("uses Playwright flaky classification instead of flattening retry failure", () => {
    const [result] = collectPlaywrightEvidence({
      suites: [
        {
          file: "web-pwa.spec.ts",
          specs: [
            {
              tests: [
                {
                  status: "flaky",
                  results: [
                    {
                      status: "failed",
                      retry: 0,
                      duration: 10,
                      error: { message: "first attempt failed" },
                    },
                    { status: "passed", retry: 1, duration: 8 },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(result).toMatchObject({
      owner: "web-pwa.spec.ts",
      status: "flaky",
      retries: 1,
      error: "first attempt failed",
      duration: 18,
    });
  });
});

describe("detectDefaultCiEnvGate", () => {
  test('detects describe.skipIf(process.env.X !== "1") whole-file gates', () => {
    const src = `import { describe } from 'vitest';
describe.skipIf(process.env.CENTRAID_RUN_NATIVE_TUNNEL !== '1')('native gateway relay', () => {
  test('x', () => {});
});
`;
    expect(detectDefaultCiEnvGate(src)).toEqual({
      env: "CENTRAID_RUN_NATIVE_TUNNEL",
      kind: "skipIf-env-not-1",
    });
  });

  test("detects env check + t.skip in the test body (disk-full pattern)", () => {
    const src = `
test('FsBlobStore.putSync against a REAL full filesystem', (t) => {
  if (process.platform !== 'darwin') {
    t.skip('disk-full e2e only runs on darwin (hdiutil)');
    return;
  }
  if (process.env.CENTRAID_DISKFULL_E2E !== '1') {
    t.skip('set CENTRAID_DISKFULL_E2E=1 (on darwin) to run the real hdiutil disk-full e2e');
    return;
  }
  expect(true).toBe(true);
});
`;
    expect(detectDefaultCiEnvGate(src)).toEqual({
      env: "CENTRAID_DISKFULL_E2E",
      kind: "early-env-return",
    });
  });

  test("returns null for ordinary tests", () => {
    expect(
      detectDefaultCiEnvGate(`test('works', () => { expect(1).toBe(1); });`)
    ).toBeNull();
  });

  test("fails closed on an unrecognized env-gated skip shape", () => {
    expect(
      detectDefaultCiEnvGate(`
        const gate = process.env.CENTRAID_ODD_GATE;
        describe.skipIf(Boolean(gate))("x", () => {});
      `)
    ).toEqual({
      env: "CENTRAID_ODD_GATE",
      kind: "unparseable-env-gate",
    });
  });
});

describe("renderSummaryMarkdown", () => {
  test("renders health table and report marker", () => {
    const md = renderSummaryMarkdown(
      {
        passed: 10,
        failed: 1,
        cellsFailed: 2,
        cellsMissing: 3,
        unhandledErrors: 1,
        unhandledErrorMessages: ["write EPIPE"],
        coverageBelowFloor: ["packages/gateway/**"],
        validationErrorCount: 0,
        generatedAt: "2026-07-19T00:00:00.000Z",
      },
      {
        reportUrl: "https://example.test/report/",
        runUrl: "https://example.test/run/1",
      }
    );
    expect(md).toContain("needs attention");
    expect(md).toContain("| Evidence failed | 1 |");
    expect(md).toContain("https://example.test/report/");
    expect(md).toContain(REPORT_COMMENT_MARKER);
    expect(md).toContain("write EPIPE");
  });

  test("marks ok when all signals clean", () => {
    const md = renderSummaryMarkdown({
      passed: 5,
      failed: 0,
      cellsFailed: 0,
      cellsMissing: 1,
      unhandledErrors: 0,
      coverageBelowFloor: [],
      validationErrorCount: 0,
    });
    expect(md).toContain("**Status:** ok");
  });
});

describe("coverageScopesBelowFloor", () => {
  test("lists scopes under line floor only", () => {
    expect(
      coverageScopesBelowFloor([
        { scope: "a", lines: 50, lineFloor: 60 },
        { scope: "b", lines: 90, lineFloor: 80 },
        { scope: "c", lines: null, lineFloor: 70 },
      ])
    ).toEqual(["a"]);
  });
});

describe("publicReportUrl", () => {
  test("builds project pages URL", () => {
    expect(
      publicReportUrl({ owner: "srikanth235", repo: "centraid", slot: "main" })
    ).toBe("https://srikanth235.github.io/centraid/test-report/main/");
  });
});

describe("findUnmappedEvidence", () => {
  test("counts orphaned e2e results and separates failed unmapped", () => {
    const matrix = {
      cellOwners: {
        "mobile.journey": {
          owner: "tests/agent-e2e-mobile/flows/home-loads.mjs",
          tier: "e2e",
        },
      },
      flows: [],
    };
    const results = [
      {
        owner: "tests/agent-e2e-mobile/flows/home-loads.mjs",
        status: "passed",
      },
      {
        owner: "tests/agent-e2e-mobile/flows/template-gate.mjs",
        status: "failed",
      },
      { owner: "tests/orphan/no-owner.mjs", status: "passed" },
    ];
    const found = findUnmappedEvidence(results, matrix);
    expect(found.unmappedEvidence).toBe(2);
    expect(found.failedUnmapped.map((r) => r.owner)).toEqual([
      "tests/agent-e2e-mobile/flows/template-gate.mjs",
    ]);
  });

  test("treats flow owners as registered", () => {
    const matrix = {
      cellOwners: { "mobile.journey": null },
      flows: [
        {
          id: "mobile-template-gate",
          owner: "tests/agent-e2e-mobile/flows/template-gate.mjs",
        },
      ],
    };
    const found = findUnmappedEvidence(
      [
        {
          owner: "tests/agent-e2e-mobile/flows/template-gate.mjs",
          status: "failed",
        },
      ],
      matrix
    );
    expect(found.unmappedEvidence).toBe(0);
    expect(found.failedUnmapped).toEqual([]);
  });
});

describe("findUnmatchedOwners", () => {
  test("names declared owners that produced no evidence key", () => {
    expect(
      findUnmatchedOwners([{ owner: "tests/a.test.ts", status: "passed" }], {
        cellOwners: {
          "a.correctness": { owner: "tests/a.test.ts", tier: "unit" },
          "b.correctness": { owner: "tests/b.test.ts", tier: "unit" },
        },
        flows: [{ owner: "tests/c.test.ts" }],
      })
    ).toEqual(["tests/b.test.ts", "tests/c.test.ts"]);
  });
});

describe("reconcileJobConclusions", () => {
  test("flags silent all-clear when needs jobs failed but summary.failed is 0", () => {
    const recon = reconcileJobConclusions(
      {
        "desktop-e2e": { result: "success" },
        "mobile-e2e": { result: "failure" },
        "mobile-e2e-android": { result: "failure" },
      },
      { failed: 0 }
    );
    expect(recon.silentAllClear).toBe(true);
    expect(recon.failedJobs).toEqual(["mobile-e2e", "mobile-e2e-android"]);
    expect(recon.message).toMatch(/mobile-e2e/u);
  });

  test("is quiet when failed evidence already accounts for the red jobs", () => {
    const recon = reconcileJobConclusions(
      { "mobile-e2e": { result: "failure" } },
      { failed: 2 }
    );
    expect(recon.silentAllClear).toBe(false);
    expect(recon.message).toBeNull();
  });
});

describe("cellsMissingRatchet", () => {
  test("detects grey creep vs prior durable history point", () => {
    const ratchet = cellsMissingRatchet(18, [
      { label: "2026-07-20", cellsMissing: 12 },
      { label: "2026-07-21", cellsMissing: 15 },
    ]);
    expect(ratchet.prior).toBe(15);
    expect(ratchet.current).toBe(18);
    expect(ratchet.delta).toBe(3);
    expect(ratchet.rose).toBe(true);
  });

  test("does not flag improvement or first run", () => {
    expect(cellsMissingRatchet(10, [{ cellsMissing: 15 }]).rose).toBe(false);
    expect(cellsMissingRatchet(10, []).rose).toBe(false);
  });
});

describe("cellIdentityRegressions", () => {
  test("detects replacement grey/red cells even when aggregate counts are flat", () => {
    expect(
      cellIdentityRegressions(
        {
          missingCellIds: ["fixed-replacement", "still-grey"],
          failedCellIds: ["new-red"],
        },
        [
          {
            missingCellIds: ["old-fixed", "still-grey"],
            failedCellIds: ["old-red"],
          },
        ]
      )
    ).toEqual({
      newMissing: ["fixed-replacement"],
      newFailed: ["new-red"],
    });
  });
});
