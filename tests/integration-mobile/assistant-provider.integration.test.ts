// Does the CI gateway's Assistant provider wiring actually resolve? (#890)
//
// `tests/agent-e2e-mobile/lib/ci-gateway.mjs` configures a model provider by
// writing three prefs, so that the mobile `sendToFirstToken` budget has a turn
// to time at all. Those prefs are just strings in a database: nothing about
// writing them proves the gateway will spawn what we meant, and the lane that
// would find out is a device lane that runs nightly at best.
//
// So this drives the REAL resolution chain the gateway uses at turn time —
// `resolveGatewayHarnessPrefs` → `acpConfigFor` → `planLaunch` — against the
// exact prefs the CI gateway writes, and asserts the plan spawns our stub. It
// is the difference between "the prefs are written" and "the prefs work", and
// it catches the failure modes that would otherwise cost a nightly cycle each:
// a mistyped pref key, a harness kind that takes the npm-adapter path instead of
// the binary path, or extraArgs being dropped for a non-configured kind.

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

// THE PREFS THE GATEWAY ACTUALLY WRITES, imported rather than restated. A local
// copy here would keep passing after ci-gateway.mjs changed, which is the exact
// way a wiring test stops meaning anything.
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

    // The whole point: `bin` is node and the script is the first argument. A
    // harness kind carrying an `adapter` would resolve an npm package here
    // instead and never reach the stub — silently, with the turn failing much
    // later as a spawn error.
    expect(plan.bin).toBe(process.execPath);
    expect(plan.args).toStrictEqual([AGENT_PATH]);
  });

  it("passes the REAL delay variable through to the spawned agent", async () => {
    // The stub's delay is the constant a latency flow subtracts, so if the spawn
    // env dropped it the agent would silently use its default and every
    // measurement taken against a configured delay would be wrong by the
    // difference, with nothing reporting a problem.
    //
    // Asserted against the variable the agent ACTUALLY reads, imported from it.
    // An earlier version of this test set an invented `…_PROBE` name and checked
    // that: it would have passed identically if the real variable were renamed
    // or deleted, which is the whole failure it was written to prevent.
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
    // The guard that makes the wiring above safe: binPath/extraArgs are one
    // harness's settings. A turn that requests a DIFFERENT kind must fall back
    // to that kind's registry defaults rather than launching our stub under its
    // name — otherwise the CI gateway would answer every harness with the stub.
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
