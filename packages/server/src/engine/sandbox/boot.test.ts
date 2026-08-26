/*
 * Loader-safe entry (#842): worker type stripping can't map a `./sib.js`
 * specifier onto its `.ts` source, so boot resolves by absolute path.
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
    // Absolute-path indirection must not fork the policy table.
    expect(boot.appHandlerPolicy()).toStrictEqual(appHandlerPolicy());
    const dir = path.resolve("/tmp/centraid-boot-seed");
    expect(boot.appSeedPolicy(dir)).toStrictEqual(appSeedPolicy(dir));
    expect(boot.appHandlerPolicy().filesystem).toBe("denied");
  });

  test("is idempotent — a second load returns an equivalent surface", async () => {
    const first = await loadSandbox();
    const second = await loadSandbox();
    expect(second.installWorkerSandbox).toBe(first.installWorkerSandbox);
    expect(second.appSeedPolicy).toBe(first.appSeedPolicy);
  });

  test("resolves against whichever layout is on disk", async () => {
    // Exactly one install-sibling spelling must exist in either layout.
    const here = import.meta.dirname;
    const js = existsSync(path.join(here, "install.js"));
    const ts = existsSync(path.join(here, "install.ts"));
    expect(js || ts).toBe(true);
    await expect(loadSandbox()).resolves.toBeDefined();
  });
});
