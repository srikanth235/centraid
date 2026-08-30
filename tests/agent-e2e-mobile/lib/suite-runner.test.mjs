import { promises as fs } from "node:fs";
import path from "node:path";

import { expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { runMobileSuite } from "./suite-runner.mjs";

/** Build a throwaway repo root removed after this test file finishes. */
async function fixture() {
  const root = await tempDir("centraid-mobile-suite-");
  return {
    root,
    environment: {
      MAESTRO_PLATFORM: "ios",
      RUNNER_TEMP: path.join(root, "tmp"),
    },
  };
}

const pairedFixture = {
  ready: true,
  runId: "flow-run-1",
  platform: "ios",
  udid: "simulator-1",
  appId: "dev.centraid.mobile",
  gatewayUrl: "http://127.0.0.1:18789",
  fixtureId: "fixture-1",
};

test("a missing pairing prerequisite blocks dependent flows", async () => {
  const { root, environment } = await fixture();
  const called = [];
  const result = await runMobileSuite({
    suite: "fixture-block",
    budgetMs: 10_000,
    flows: [
      { name: "bootstrap", file: "/bootstrap.mjs" },
      { name: "dependent", file: "/dependent.mjs", reusePairedState: true },
    ],
    environment,
    repoRoot: root,
    runnerTemp: environment.RUNNER_TEMP,
    failProcess: false,
    childRunner: async (file) => {
      called.push(file);
      return { code: 1, timedOut: false };
    },
  });
  expect(called).toEqual(["/bootstrap.mjs"]);
  expect(result.results.map(({ status }) => status)).toEqual([
    "failure",
    "blocked",
  ]);
  expect(result.results[0].failureClass).toBe("prerequisite");
  expect(result.results[0].phase).toBe("fixture_or_pairing");
});

test("a child-runner exception becomes structured infrastructure evidence", async () => {
  const { root, environment } = await fixture();
  const result = await runMobileSuite({
    suite: "child-runner-error",
    budgetMs: 10_000,
    flows: [{ name: "bootstrap", file: "/bootstrap.mjs" }],
    environment,
    repoRoot: root,
    runnerTemp: environment.RUNNER_TEMP,
    failProcess: false,
    childRunner: async () => {
      throw new Error("driver could not be started");
    },
  });
  expect(result.results.map(({ status }) => status)).toEqual(["failure"]);
  expect(result.results[0].failureClass).toBe("infrastructure");
  expect(result.results[0].phase).toBe("execution");
  expect(result.results[0].reason).toMatch(/driver could not be started/u);
  await expect(
    fs.access(
      path.join(root, "artifacts/e2e-suites/ios-child-runner-error.json")
    )
  ).resolves.toBeUndefined();
});

test("a ready-only marker cannot establish a paired fixture", async () => {
  const { root, environment } = await fixture();
  const result = await runMobileSuite({
    suite: "malformed-marker",
    budgetMs: 10_000,
    flows: [
      { name: "bootstrap", file: "/bootstrap.mjs" },
      { name: "dependent", file: "/dependent.mjs", reusePairedState: true },
    ],
    environment,
    repoRoot: root,
    runnerTemp: environment.RUNNER_TEMP,
    failProcess: false,
    childRunner: async (_file, { env }) => {
      await fs.mkdir(path.dirname(env.MOBILE_E2E_PREREQUISITE_FILE), {
        recursive: true,
      });
      await fs.writeFile(env.MOBILE_E2E_PREREQUISITE_FILE, '{"ready":true}\n');
      return { code: 0, timedOut: false };
    },
  });
  expect(result.results.map(({ status }) => status)).toEqual([
    "failure",
    "blocked",
  ]);
});

test("a journey failure after pairing does not masquerade as fixture failure", async () => {
  const { root, environment } = await fixture();
  const called = [];
  const result = await runMobileSuite({
    suite: "journey-failure",
    budgetMs: 10_000,
    flows: [
      { name: "first", file: "/first.mjs" },
      { name: "second", file: "/second.mjs", reusePairedState: true },
    ],
    environment,
    repoRoot: root,
    runnerTemp: environment.RUNNER_TEMP,
    failProcess: false,
    childRunner: async (file, { env }) => {
      called.push(file);
      await fs.mkdir(path.dirname(env.MOBILE_E2E_PREREQUISITE_FILE), {
        recursive: true,
      });
      await fs.writeFile(
        env.MOBILE_E2E_PREREQUISITE_FILE,
        `${JSON.stringify(pairedFixture)}\n`
      );
      return { code: file === "/first.mjs" ? 1 : 0, timedOut: false };
    },
  });
  expect(called).toEqual(["/first.mjs", "/second.mjs"]);
  expect(result.results.map(({ status }) => status)).toEqual([
    "failure",
    "success",
  ]);
  expect(result.results[0].failureClass).toBe("product_assertion");
  expect(result.results[0].phase).toBe("assertion");
});

test("a required fixture journey failure blocks the remaining suite", async () => {
  const { root, environment } = await fixture();
  const result = await runMobileSuite({
    suite: "required-flow",
    budgetMs: 10_000,
    flows: [
      {
        name: "seeded library",
        file: "/library.mjs",
        requiredForFollowing: true,
      },
      { name: "viewer", file: "/viewer.mjs", reusePairedState: true },
    ],
    environment,
    repoRoot: root,
    runnerTemp: environment.RUNNER_TEMP,
    failProcess: false,
    childRunner: async (_file, { env }) => {
      await fs.mkdir(path.dirname(env.MOBILE_E2E_PREREQUISITE_FILE), {
        recursive: true,
      });
      await fs.writeFile(
        env.MOBILE_E2E_PREREQUISITE_FILE,
        `${JSON.stringify(pairedFixture)}\n`
      );
      return { code: 1, timedOut: false };
    },
  });
  expect(result.results.map(({ status }) => status)).toEqual([
    "failure",
    "blocked",
  ]);
});

test("a changed paired identity fails closed and blocks dependants", async () => {
  const { root, environment } = await fixture();
  let call = 0;
  const result = await runMobileSuite({
    suite: "identity-change",
    budgetMs: 10_000,
    flows: [
      { name: "bootstrap", file: "/bootstrap.mjs" },
      { name: "changed", file: "/changed.mjs", reusePairedState: true },
      { name: "dependant", file: "/dependant.mjs", reusePairedState: true },
    ],
    environment,
    repoRoot: root,
    runnerTemp: environment.RUNNER_TEMP,
    failProcess: false,
    childRunner: async (_file, { env }) => {
      call += 1;
      await fs.mkdir(path.dirname(env.MOBILE_E2E_PREREQUISITE_FILE), {
        recursive: true,
      });
      await fs.writeFile(
        env.MOBILE_E2E_PREREQUISITE_FILE,
        `${JSON.stringify({ ...pairedFixture, fixtureId: call === 1 ? "fixture-1" : "fixture-2" })}\n`
      );
      return { code: 0, timedOut: false };
    },
  });
  expect(result.results.map(({ status }) => status)).toEqual([
    "success",
    "failure",
    "blocked",
  ]);
});
