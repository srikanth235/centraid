/*
 * The sandbox's loader-safe entry point (#842 W7.1).
 *
 * `boot.ts` exists because a worker runner cannot import the sandbox the
 * ordinary way: worker threads boot under Node's native type stripping, which
 * runs a `.ts` file handed to it directly but does not map a `./sibling.js`
 * specifier onto its `.ts` source. So boot has zero relative imports and resolves
 * the rest of the sandbox by absolute path, preferring compiled `.js`.
 *
 * That makes it the single point of failure for the whole slice — if it cannot
 * load, `engine/worker/runner.ts` throws and the handler does not run, which is
 * the correct direction but only if the loader itself works in BOTH layouts.
 *
 * `loadSandbox()` resolves and imports; it installs nothing, revokes no global
 * and registers no hook, so it is safe to call in-process here.
 */

import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { loadSandbox } from "./boot.js";
import { appHandlerPolicy, appSeedPolicy } from "./policy.js";

describe(loadSandbox, () => {
  test("hands back the whole policy surface the runners call", async () => {
    const boot = await loadSandbox();
    for (const name of [
      "installWorkerSandbox",
      "appHandlerPolicy",
      "appSeedPolicy",
      "automationHandlerPolicy",
      "modelRuntimePolicy",
    ] as const)
      expect(boot[name], `boot must expose ${name}`).toBeTypeOf("function");
  });

  test("the policies it returns are the shipped ones, not re-derived", async () => {
    const boot = await loadSandbox();
    // Loading through the absolute-path indirection must not produce a second,
    // divergent copy of the policy table: a lane that widened only in the
    // worker's copy would be invisible to `policy.test.ts`.
    expect(boot.appHandlerPolicy()).toStrictEqual(appHandlerPolicy());
    const dir = path.resolve("/tmp/centraid-boot-seed");
    expect(boot.appSeedPolicy(dir)).toStrictEqual(appSeedPolicy(dir));
    expect(boot.appHandlerPolicy().filesystem).toBe("denied");
  });

  test("is idempotent — a second load returns an equivalent surface", async () => {
    // Pooled workers call this once each, but the sibling-resolution fallback
    // it may install is process-global and guarded by a latch; loading twice
    // must not register it twice or throw.
    const first = await loadSandbox();
    const second = await loadSandbox();
    expect(second.installWorkerSandbox).toBe(first.installWorkerSandbox);
    expect(second.appSeedPolicy).toBe(first.appSeedPolicy);
  });

  test("resolves against whichever layout is on disk", async () => {
    // The claim boot.ts is built on: under `dist/` the compiled `.js` siblings
    // exist and plain resolution works; from `src/` they do not and the `.ts`
    // fallback is required. Whichever tree this test runs in, exactly one of
    // the two spellings must be present for the loader to have succeeded.
    const here = import.meta.dirname;
    const js = existsSync(path.join(here, "install.js"));
    const ts = existsSync(path.join(here, "install.ts"));
    expect(js || ts).toBe(true);
    await expect(loadSandbox()).resolves.toBeDefined();
  });
});
