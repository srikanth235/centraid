/*
 * The agents-status route reports the v0-supported runner roster while the
 * broader backend registry remains available to persisted configuration.
 * These tests cover the offered list shape and resolver plumbing; the CLI
 * probe itself runs for real and is not asserted on (its result varies by
 * host).
 */

import { SUPPORTED_RUNNER_KINDS } from "@centraid/agent-runtime";
import { describe, expect, test } from "vitest";

import { readAgentsStatus } from "./agents-routes.ts";

describe("agents-routes", () => {
  test("reports one entry per supported runner kind", async () => {
    const s = await readAgentsStatus();
    expect(s.agents.map((a) => a.kind).sort()).toStrictEqual(
      [...SUPPORTED_RUNNER_KINDS].sort()
    );
    // Every entry is self-describing: the client renders off these, never off a
    // local table keyed on kinds it happens to know.
    for (const agent of s.agents) {
      expect(agent.label).toBeTypeOf("string");
      expect(agent.label.length).toBeGreaterThan(0);
      expect(agent.available).toBeTypeOf("boolean");
      expect(agent.minVersion).toMatch(/^\d+\.\d+\.\d+$/u);
    }
  });

  test("carries no per-agent tools surface — that retired with the drawer", async () => {
    const s = await readAgentsStatus({
      resolveModels: async () => ({ list: [], status: "ready" }),
    });
    for (const agent of s.agents) {
      expect("tools" in agent).toBe(false);
      expect("toolsStatus" in agent).toBe(false);
    }
    expect(JSON.stringify(s)).not.toContain("Tools");
  });

  test("an unavailable agent carries the install hint; an available one does not", async () => {
    const s = await readAgentsStatus({
      binPathFor: (kind) =>
        kind === "pi" ? "/definitely/not/a/runner" : undefined,
      refresh: true,
    });
    const pi = s.agents.find((a) => a.kind === "pi");
    expect(pi?.available).toBe(false);
    expect(pi?.hint).toBeTruthy();
    expect(
      s.agents
        .filter((agent) => agent.available)
        .every((agent) => agent.hint === undefined)
    ).toBe(true);
  });

  test("probes the configured binary for a kind when one is supplied", async () => {
    const seen: Array<string | undefined> = [];
    await readAgentsStatus({
      binPathFor: (kind) => {
        seen.push(kind);
        return kind === "pi" ? "/nonexistent/custom-agent" : undefined;
      },
    });
    // Every product-supported kind is offered the override, not just a known pair.
    expect(seen.sort()).toStrictEqual([...SUPPORTED_RUNNER_KINDS].sort());
  });

  test("defaults every agent to an empty model surface when no resolver is supplied", async () => {
    const s = await readAgentsStatus();
    for (const agent of s.agents) {
      expect(agent.models).toStrictEqual([]);
      expect(agent.modelsStatus).toBe("empty");
      expect(agent.defaultModel).toBeUndefined();
    }
  });

  test("attaches each agent’s models + status from the resolver", async () => {
    const calls: Array<[string, boolean]> = [];
    const s = await readAgentsStatus({
      resolveModels: async (kind, refresh) => {
        calls.push([kind, refresh]);
        return {
          list: [{ id: `${kind}-x`, name: "X", default: true }],
          status: "ready",
        };
      },
    });
    // Asked once per registered kind, and each answer landed on its own entry.
    expect(calls.map(([k]) => k).sort()).toStrictEqual(
      [...SUPPORTED_RUNNER_KINDS].sort()
    );
    const codex = s.agents.find((a) => a.kind === "codex");
    expect(codex?.models).toStrictEqual([
      { id: "codex-x", name: "X", default: true },
    ]);
    expect(codex?.modelsStatus).toBe("ready");
    // The catalog's own default is surfaced so a picker can name what it inherits.
    expect(codex?.defaultModel).toBe("codex-x");
  });

  test("surfaces a loading surface so the client knows to poll", async () => {
    const s = await readAgentsStatus({
      resolveModels: async () => ({ list: [], status: "loading" }),
    });
    expect(s.agents.every((a) => a.modelsStatus === "loading")).toBe(true);
  });

  test("threads the refresh flag to the resolver for every agent", async () => {
    const seen: boolean[] = [];
    await readAgentsStatus({
      resolveModels: async (_kind, refresh) => {
        seen.push(refresh);
        return { list: [], status: "loading" };
      },
      refresh: true,
    });
    expect(seen).toStrictEqual(SUPPORTED_RUNNER_KINDS.map(() => true));
  });

  test("a throwing resolver degrades that agent to an empty list", async () => {
    const s = await readAgentsStatus({
      resolveModels: async (kind) => {
        if (kind === "codex") throw new Error("boom");
        return { list: [{ id: "ok" }], status: "ready" };
      },
    });
    const codex = s.agents.find((a) => a.kind === "codex");
    expect(codex?.models).toStrictEqual([]);
    expect(codex?.modelsStatus).toBe("empty");
    // One agent's failure never takes the rest of the list down with it.
    expect(s.agents.find((a) => a.kind === "opencode")?.modelsStatus).toBe(
      "ready"
    );
  });
});
