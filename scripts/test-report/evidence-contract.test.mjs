import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import {
  EVIDENCE_SCHEMA_VERSION,
  PLATFORMS,
  VERDICTS,
  validateEvidence,
} from "./evidence-schema.mjs";
import { readEvidenceDir } from "./read-evidence.mjs";
import {
  buildEvidence,
  lookupPark,
  parseArgs,
  resolveVerdict,
} from "./write-evidence.mjs";

function sample(overrides = {}) {
  return {
    schema: EVIDENCE_SCHEMA_VERSION,
    lane: "mobile-e2e-android",
    rung: 4,
    platform: "android",
    candidate: "0a3258e3a",
    startedAt: "2026-09-02T06:00:00Z",
    finishedAt: "2026-09-02T06:40:00Z",
    verdict: "passed",
    budgetMs: 3_600_000,
    durationMs: 2_400_000,
    cases: [
      {
        id: "pairing-canary",
        verdict: "passed",
        durationMs: 171_000,
        attempts: 1,
      },
    ],
    parked: null,
    tags: { qualities: ["journey"], surfaces: ["mobile-native"] },
    ...overrides,
  };
}

describe("the evidence vocabulary", () => {
  it("is exactly four words", () => {
    expect([...VERDICTS]).toEqual([
      "passed",
      "failed",
      "parked",
      "no-evidence",
    ]);
  });

  it("names every platform a lane can run against", () => {
    expect(PLATFORMS).toContain("ios");
    expect(PLATFORMS).toContain("gateway");
  });
});

describe("validateEvidence", () => {
  it("accepts a well-formed lane file", () => {
    expect(validateEvidence(sample())).toEqual({ ok: true, errors: [] });
  });

  it("collects every problem rather than the first", () => {
    const { ok, errors } = validateEvidence(
      sample({ rung: 9, platform: "toaster", verdict: "flaky" })
    );
    expect(ok).toBe(false);
    expect(errors).toHaveLength(3);
  });

  it("refuses a parked verdict with no park behind it", () => {
    const { errors } = validateEvidence(
      sample({ verdict: "parked", parked: null })
    );
    expect(errors).toContain(
      "a parked verdict must carry the park it is parked under"
    );
  });

  it("refuses a park with no issue number", () => {
    const { errors } = validateEvidence(
      sample({ parked: { until: "2026-09-16" } })
    );
    expect(errors).toContain("parked.issue must be a positive issue number");
  });

  it("refuses a finish before its start", () => {
    const { errors } = validateEvidence(
      sample({
        startedAt: "2026-09-02T07:00:00Z",
        finishedAt: "2026-09-02T06:00:00Z",
      })
    );
    expect(errors).toContain("finishedAt must not precede startedAt");
  });

  it("refuses a case with an unknown verdict", () => {
    const { errors } = validateEvidence(
      sample({ cases: [{ id: "x", verdict: "parked", durationMs: 1 }] })
    );
    expect(errors[0]).toMatch(/cases\[0\]\.verdict/u);
  });

  it("refuses a future schema version", () => {
    const { ok } = validateEvidence(
      sample({ schema: EVIDENCE_SCHEMA_VERSION + 1 })
    );
    expect(ok).toBe(false);
  });
});

describe("the writer CLI", () => {
  it("rejects an unknown flag rather than writing defaults", () => {
    expect(() =>
      parseArgs(["--lane", "a", "--rungg", "4"], new Set(["lane"]))
    ).toThrow(/unknown flag/u);
  });

  it("maps job.status onto a verdict", () => {
    expect(resolveVerdict("auto", "success")).toBe("passed");
    expect(resolveVerdict("auto", "failure")).toBe("failed");
    expect(resolveVerdict("auto", "cancelled")).toBe("failed");
    expect(resolveVerdict("passed", undefined)).toBe("passed");
  });

  it("needs a job status when the verdict is auto", () => {
    expect(() => resolveVerdict("auto", undefined)).toThrow(/--job-status/u);
  });

  it("finds an unexpired lane park and ignores an expired one", () => {
    const ledger = JSON.stringify({
      lanes: { "mobile-e2e-ios": { issue: 870, expires: "2026-09-16" } },
    });
    const read = (name) => (name === "tests/quarantine.json" ? ledger : null);
    expect(lookupPark("mobile-e2e-ios", read, "2026-09-02")).toEqual({
      until: "2026-09-16",
      issue: 870,
    });
    expect(lookupPark("mobile-e2e-ios", read, "2026-09-17")).toBeNull();
  });

  it("reads the merged quarantine ledger's lanes block (#915 Wave 4)", () => {
    const read = (name) =>
      name === "tests/quarantine.json"
        ? JSON.stringify({
            lanes: { soak: { issue: "#901", until: "2026-10-01" } },
          })
        : null;
    expect(lookupPark("soak", read, "2026-09-02")).toEqual({
      until: "2026-10-01",
      issue: 901,
    });
  });

  it("writes parked, never failed, for a parked lane", () => {
    const evidence = buildEvidence(
      {
        lane: "mobile-e2e-ios",
        rung: 4,
        platform: "ios",
        verdict: "auto",
        "job-status": "failure",
        "started-at": "2026-09-02T06:00:00Z",
        "finished-at": "2026-09-02T06:10:00Z",
        "budget-ms": "600000",
      },
      {
        now: new Date("2026-09-02T06:10:00Z"),
        park: { until: "2026-09-16", issue: 870 },
        cases: [],
      }
    );
    expect(evidence.verdict).toBe("parked");
    expect(validateEvidence(evidence).ok).toBe(true);
  });

  it("derives duration from the two timestamps", () => {
    const evidence = buildEvidence(
      {
        lane: "static",
        rung: 2,
        platform: "any",
        verdict: "passed",
        "started-at": "2026-09-02T06:00:00Z",
        "finished-at": "2026-09-02T06:05:00Z",
        "budget-ms": "300000",
        qualities: "correctness, contracts",
      },
      { now: new Date("2026-09-02T06:05:00Z"), park: null, cases: [] }
    );
    expect(evidence.durationMs).toBe(300_000);
    expect(evidence.tags.qualities).toEqual(["correctness", "contracts"]);
  });
});

describe("readEvidenceDir", () => {
  it("reads valid files and reports malformed ones instead of dropping them", () => {
    const dir = tempDirSync("centraid-evidence-");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "static.json"),
      JSON.stringify(sample({ lane: "static", platform: "any", rung: 2 }))
    );
    writeFileSync(path.join(dir, "broken.json"), "{ not json");
    writeFileSync(
      path.join(dir, "wrong-name.json"),
      JSON.stringify(sample({ lane: "static2" }))
    );

    const { lanes, errors } = readEvidenceDir(dir);
    expect([...lanes.keys()]).toEqual(["static"]);
    expect(errors).toHaveLength(2);
    expect(errors.join("\n")).toMatch(/broken\.json/u);
    expect(errors.join("\n")).toMatch(/should be named static2\.json/u);
  });

  it("treats an absent directory as no evidence, not as an error", () => {
    const { lanes, errors } = readEvidenceDir(
      path.join(tmpdir(), "centraid-no-such-dir-915")
    );
    expect(lanes.size).toBe(0);
    expect(errors).toEqual([]);
  });
});
