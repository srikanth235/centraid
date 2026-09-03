import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import {
  defaultRunId,
  qualityRegressionBudget,
  recordQualityResult,
  writeFlowVerdict,
} from "./harness.mjs";

function makeRunDir() {
  return tempDir("centraid-harness-");
}

describe("defaultRunId", () => {
  test("returns an ISO-stamp plus hex suffix without colons/dots/Z", () => {
    const id = defaultRunId();
    expect(id).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}-[0-9a-f]{6}$/u
    );
    expect(id).not.toContain(":");
    expect(id).not.toContain(".");
    expect(id.endsWith("Z")).toBe(false);
  });

  test("is unique across rapid calls", () => {
    const a = defaultRunId();
    const b = defaultRunId();
    expect(a).not.toBe(b);
  });
});

describe("qualityRegressionBudget", () => {
  test("waits for ten durable observations before enabling the budget", async () => {
    const repoRoot = await makeRunDir();
    expect(
      await qualityRegressionBudget(repoRoot, "scale", "mobile-volume")
    ).toBeNull();
    await Array.from({ length: 10 }, (_, index) => index + 1).reduce(
      async (previous, value) => {
        await previous;
        await recordQualityResult(repoRoot, {
          lane: "scale",
          owner: "mobile-volume",
          name: "volume",
          status: "passed",
          measurements: [{ name: "wall clock", value, unit: "ms" }],
        });
      },
      Promise.resolve()
    );
    expect(
      await qualityRegressionBudget(repoRoot, "scale", "mobile-volume")
    ).toBe(16.5);
  });
});

describe("writeFlowVerdict", () => {
  test("writes PASS verdict.md and optional evidence JSON", async () => {
    const runDir = await makeRunDir();
    const repoRoot = runDir;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const pass = await writeFlowVerdict({
        repoRoot,
        slug: "pairing-smoke",
        runDir,
        elapsedMs: 42,
        error: null,
        notes: ["device paired"],
        result: { pass: true, notes: "all green" },
        metadata: { platform: "desktop" },
        owner: "pairing",
      });
      expect(pass).toBe(true);
      const verdict = await readFile(path.join(runDir, "verdict.md"), "utf8");
      expect(verdict).toContain("# pairing-smoke");
      expect(verdict).toContain("**PASS** — 42ms");
      expect(verdict).toContain("- platform: `desktop`");
      expect(verdict).toContain("- device paired");
      expect(verdict).toContain("all green");
      const evidence = JSON.parse(
        await readFile(
          path.join(repoRoot, "artifacts", "e2e", "pairing-smoke.json"),
          "utf8"
        )
      );
      expect(evidence).toMatchObject({
        lane: "e2e",
        owner: "pairing",
        name: "pairing-smoke",
        status: "passed",
      });
      expect(evidence.measurements[0]).toMatchObject({
        name: "wall clock",
        value: 42,
        unit: "ms",
      });
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("pairing-smoke PASS")
      );
    } finally {
      log.mockRestore();
    }
  });

  test("FAIL when error is set, including stack and debug sections", async () => {
    const runDir = await makeRunDir();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const err = new Error("timeout waiting for pair");
      const pass = await writeFlowVerdict({
        repoRoot: runDir,
        slug: "mobile-share",
        runDir,
        elapsedMs: 9,
        error: err,
        notes: [],
        result: undefined,
        debug: "screenshot: /tmp/x.png",
        owner: null,
      });
      expect(pass).toBe(false);
      const verdict = await readFile(path.join(runDir, "verdict.md"), "utf8");
      expect(verdict).toContain("**FAIL** — 9ms");
      expect(verdict).toContain("## Error");
      expect(verdict).toContain("timeout waiting for pair");
      expect(verdict).toContain("## Debug");
      expect(verdict).toContain("screenshot: /tmp/x.png");
    } finally {
      log.mockRestore();
    }
  });

  test("FAIL when result.pass is explicitly false", async () => {
    const runDir = await makeRunDir();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const pass = await writeFlowVerdict({
        repoRoot: runDir,
        slug: "soft-fail",
        runDir,
        elapsedMs: 1,
        error: null,
        notes: [],
        result: { pass: false, notes: "assertion missed" },
      });
      expect(pass).toBe(false);
      const verdict = await readFile(path.join(runDir, "verdict.md"), "utf8");
      expect(verdict).toContain("**FAIL**");
      expect(verdict).toContain("assertion missed");
    } finally {
      log.mockRestore();
    }
  });
});

describe("platform-keyed evidence (#781)", () => {
  test("writeFlowVerdict suffixes the evidence file with MAESTRO_PLATFORM and stamps it", async () => {
    const runDir = await makeRunDir();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubEnv("MAESTRO_PLATFORM", "ios");
    try {
      await writeFlowVerdict({
        repoRoot: runDir,
        slug: "home-loads",
        runDir,
        elapsedMs: 5,
        error: null,
        notes: [],
        result: { pass: true },
        owner: "tests/agent-e2e-mobile/flows/home-loads.mjs",
      });
      const evidence = JSON.parse(
        await readFile(
          path.join(runDir, "artifacts", "e2e", "home-loads-ios.json"),
          "utf8"
        )
      );
      expect(evidence).toMatchObject({
        owner: "tests/agent-e2e-mobile/flows/home-loads.mjs",
        name: "home-loads",
        platform: "ios",
        status: "passed",
      });
    } finally {
      vi.unstubAllEnvs();
      log.mockRestore();
    }
  });

  test("writeFlowVerdict keeps the unsuffixed path when no platform is set", async () => {
    const runDir = await makeRunDir();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await writeFlowVerdict({
        repoRoot: runDir,
        slug: "pairing-smoke",
        runDir,
        elapsedMs: 3,
        error: null,
        notes: [],
        result: { pass: true },
        owner: "tests/agent-e2e-pairing/flows/pairing-smoke.mjs",
      });
      const evidence = JSON.parse(
        await readFile(
          path.join(runDir, "artifacts", "e2e", "pairing-smoke.json"),
          "utf8"
        )
      );
      expect(evidence.platform).toBeUndefined();
    } finally {
      log.mockRestore();
    }
  });

  test("recordQualityResult keys the artifact and its history per platform", async () => {
    const repoRoot = await makeRunDir();
    vi.stubEnv("MAESTRO_PLATFORM", "ios");
    try {
      await recordQualityResult(repoRoot, {
        lane: "scale",
        owner: "tests/agent-e2e-mobile/flows/cold-start.mjs",
        name: "cold start",
        status: "passed",
        measurements: [{ name: "median cold start", value: 1200, unit: "ms" }],
      });
      const ios = JSON.parse(
        await readFile(
          path.join(
            repoRoot,
            "artifacts",
            "scale",
            "tests-agent-e2e-mobile-flows-cold-start-mjs-ios.json"
          ),
          "utf8"
        )
      );
      expect(ios.platform).toBe("ios");
      expect(ios.history).toHaveLength(1);

      vi.stubEnv("MAESTRO_PLATFORM", "android");
      await recordQualityResult(repoRoot, {
        lane: "scale",
        owner: "tests/agent-e2e-mobile/flows/cold-start.mjs",
        name: "cold start",
        status: "passed",
        measurements: [{ name: "median cold start", value: 3400, unit: "ms" }],
      });
      const android = JSON.parse(
        await readFile(
          path.join(
            repoRoot,
            "artifacts",
            "scale",
            "tests-agent-e2e-mobile-flows-cold-start-mjs-android.json"
          ),
          "utf8"
        )
      );
      expect(android.history).toHaveLength(1);
      expect(android.history[0].value).toBe(3400);
      expect(ios.history[0].value).toBe(1200);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("drift budgets read only their own platform's history", async () => {
    const repoRoot = await makeRunDir();
    vi.stubEnv("MAESTRO_PLATFORM", "ios");
    try {
      await Array.from({ length: 10 }, (_, index) => index + 1).reduce(
        async (previous, value) => {
          await previous;
          await recordQualityResult(repoRoot, {
            lane: "scale",
            owner: "mobile-volume",
            name: "volume",
            status: "passed",
            measurements: [{ name: "wall clock", value, unit: "ms" }],
          });
        },
        Promise.resolve()
      );
      expect(
        await qualityRegressionBudget(repoRoot, "scale", "mobile-volume")
      ).toBe(16.5);
      vi.stubEnv("MAESTRO_PLATFORM", "android");
      expect(
        await qualityRegressionBudget(repoRoot, "scale", "mobile-volume")
      ).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
