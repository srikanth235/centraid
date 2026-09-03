import path from "node:path";

import { describe, expect, it } from "vitest";

import { planLaunch } from "../../packages/server/src/acp/backends/acp/launch.js";
import { acpConfigFor } from "../../packages/server/src/acp/registry.js";
import { resolveGatewayHarnessPrefs } from "../../packages/server/src/serve/harness-prefs.js";
import { stubHarnessPrefs } from "../agent-e2e-mobile/lib/fixed-delay-agent.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const AGENT_PATH = path.join(
  REPO_ROOT,
  "tests/agent-e2e-mobile/lib/fixed-delay-agent.mjs"
);

const CI_GATEWAY_PREFS: Record<string, unknown> = stubHarnessPrefs();

describe("the mobile CI gateway's Assistant provider", () => {
  it("resolves the configured custom ACP agent", () => {
    const prefs = resolveGatewayHarnessPrefs(CI_GATEWAY_PREFS);
    expect(prefs.kind).toBe("acp");
    expect(prefs.binPath).toBe(process.execPath);
    expect(prefs.extraArgs).toStrictEqual([AGENT_PATH]);
  });

  it("plans a launch that spawns our stub, not an npm adapter", () => {
    const prefs = resolveGatewayHarnessPrefs(CI_GATEWAY_PREFS);
    const plan = planLaunch(
      acpConfigFor(prefs.kind, {
        ...(prefs.binPath ? { binPath: prefs.binPath } : {}),
        ...(prefs.extraArgs ? { extraArgs: prefs.extraArgs } : {}),
      }),
      undefined,
      []
    );

    expect(plan.bin).toBe(process.execPath);
    expect(plan.args).toStrictEqual([AGENT_PATH]);
  });

  it("passes the REAL delay variable through to the spawned agent", async () => {
    const { FIRST_TOKEN_DELAY_ENV } =
      await import("../agent-e2e-mobile/lib/fixed-delay-agent.mjs");
    const previous = process.env[FIRST_TOKEN_DELAY_ENV];
    process.env[FIRST_TOKEN_DELAY_ENV] = "42";
    try {
      const plan = planLaunch(
        acpConfigFor("acp", { binPath: process.execPath }),
        undefined,
        []
      );
      expect(plan.env[FIRST_TOKEN_DELAY_ENV]).toBe("42");
    } finally {
      if (previous === undefined) delete process.env[FIRST_TOKEN_DELAY_ENV];
      else process.env[FIRST_TOKEN_DELAY_ENV] = previous;
    }
  });

  it("refuses to resolve a binary for a kind that is not the configured one", () => {
    const prefs = resolveGatewayHarnessPrefs(
      CI_GATEWAY_PREFS,
      undefined,
      "gemini"
    );
    expect(prefs.kind).toBe("gemini");
    expect(prefs.binPath).toBeUndefined();
    expect(prefs.extraArgs).toBeUndefined();
  });
});
