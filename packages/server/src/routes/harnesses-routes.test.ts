/*
 * The harnesses-status route reports the v0-supported harness roster while the
 * broader harness registry remains available to persisted configuration.
 * These tests cover the offered list shape and resolver plumbing; the CLI
 * probe itself runs for real and is not asserted on (its result varies by
 * host).
 */

import { describe, expect, test } from "vitest";

import { SUPPORTED_HARNESS_KINDS } from "@centraid/server/acp";

import type { HarnessAcpCapabilities } from "./harnesses-routes.ts";
import {
  modelsFromCapabilities,
  readHarnessesStatus,
} from "./harnesses-routes.ts";

/** A probed snapshot carrying only the axes these tests read. */
function caps(
  configOptions: HarnessAcpCapabilities["configOptions"]
): HarnessAcpCapabilities {
  return {
    reachable: true,
    loadSession: true,
    resume: true,
    close: true,
    additionalDirectories: true,
    mcpHttp: true,
    mcpSse: false,
    modelConfigurable: (configOptions ?? []).some(
      (option) => option.category === "model"
    ),
    ...(configOptions ? { configOptions } : {}),
    authRequired: false,
    promptImage: true,
  };
}

const compareStringValues = (
  left: string | undefined,
  right: string | undefined
): number => {
  const leftString = String(left);
  const rightString = String(right);
  return leftString < rightString ? -1 : leftString > rightString ? 1 : 0;
};

describe("harnesses-routes", () => {
  test("reports one entry per supported harness kind", async () => {
    const s = await readHarnessesStatus();
    expect(
      s.harnesses.map((a) => a.kind).sort(compareStringValues)
    ).toStrictEqual([...SUPPORTED_HARNESS_KINDS].sort(compareStringValues));
    // Every entry is self-describing: the client renders off these, never off a
    // local table keyed on kinds it happens to know.
    for (const harness of s.harnesses) {
      expect(harness.label).toBeTypeOf("string");
      expect(harness.label.length).toBeGreaterThan(0);
      expect(harness.available).toBeTypeOf("boolean");
      expect(harness.minVersion).toMatch(/^\d+\.\d+\.\d+$/u);
    }
  });

  test("carries no per-harness tools surface — that retired with the drawer", async () => {
    const s = await readHarnessesStatus({
      resolveModels: async () => ({ list: [], status: "ready" }),
    });
    for (const harness of s.harnesses) {
      expect("tools" in harness).toBe(false);
      expect("toolsStatus" in harness).toBe(false);
    }
    expect(JSON.stringify(s)).not.toContain("Tools");
  });

  test("an unavailable harness carries the install hint; an available one does not", async () => {
    const s = await readHarnessesStatus({
      binPathFor: (kind) =>
        kind === "pi" ? "/definitely/not/a/harness" : undefined,
      refresh: true,
    });
    const pi = s.harnesses.find((a) => a.kind === "pi");
    expect(pi?.available).toBe(false);
    expect(pi?.hint).toBeTruthy();
    expect(
      s.harnesses
        .filter((harness) => harness.available)
        .every((harness) => harness.hint === undefined)
    ).toBe(true);
  });

  test("probes the configured binary for a kind when one is supplied", async () => {
    const seen: Array<string | undefined> = [];
    await readHarnessesStatus({
      binPathFor: (kind) => {
        seen.push(kind);
        return kind === "pi" ? "/nonexistent/custom-harness" : undefined;
      },
    });
    // Every product-supported kind is offered the override, not just a known pair.
    expect(seen.sort(compareStringValues)).toStrictEqual(
      [...SUPPORTED_HARNESS_KINDS].sort(compareStringValues)
    );
  });

  test("defaults every harness to an empty model surface when no resolver is supplied", async () => {
    const s = await readHarnessesStatus();
    for (const harness of s.harnesses) {
      expect(harness.models).toStrictEqual([]);
      expect(harness.modelsStatus).toBe("empty");
      expect(harness.defaultModel).toBeUndefined();
    }
  });

  test("attaches each harness’s models + status from the resolver", async () => {
    const calls: Array<[string, boolean]> = [];
    const s = await readHarnessesStatus({
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
      [...SUPPORTED_HARNESS_KINDS].sort((a, b) => a.localeCompare(b))
    );
    const codex = s.harnesses.find((a) => a.kind === "codex");
    expect(codex?.models).toStrictEqual([
      { id: "codex-x", name: "X", default: true },
    ]);
    expect(codex?.modelsStatus).toBe("ready");
    // The catalog's own default is surfaced so a picker can name what it inherits.
    expect(codex?.defaultModel).toBe("codex-x");
  });

  test("surfaces a loading surface so the client knows to poll", async () => {
    const s = await readHarnessesStatus({
      resolveModels: async () => ({ list: [], status: "loading" }),
    });
    expect(s.harnesses.every((a) => a.modelsStatus === "loading")).toBe(true);
  });

  test("threads the refresh flag to the resolver for every harness", async () => {
    const seen: boolean[] = [];
    await readHarnessesStatus({
      resolveModels: async (_kind, refresh) => {
        seen.push(refresh);
        return { list: [], status: "loading" };
      },
      refresh: true,
    });
    expect(seen).toStrictEqual(SUPPORTED_HARNESS_KINDS.map(() => true));
  });

  // Catalog enumeration is opt-in per kind (codex + claude-code), but the
  // capability probe launches every available harness anyway and reads the same
  // session/new model option. Consulting only the (empty) catalog shows
  // "Built-in model" while opencode advertises 76 models there.
  test("falls an empty catalog back to the models the capability probe saw", () => {
    const models = modelsFromCapabilities(
      caps([
        {
          id: "model",
          category: "model",
          type: "select",
          currentValue: "opencode/sonnet",
          values: [
            { value: "opencode/sonnet", name: "OpenCode Zen/Sonnet" },
            { value: "opencode/haiku" },
          ],
        },
      ])
    );
    // Only what the harness itself offered — and its own current pick is the default.
    expect(models).toStrictEqual([
      { id: "opencode/sonnet", name: "OpenCode Zen/Sonnet", default: true },
      { id: "opencode/haiku" },
    ]);
  });

  test("stays empty when the probe found no model option, or no probe ran", () => {
    expect(modelsFromCapabilities(undefined)).toStrictEqual([]);
    expect(modelsFromCapabilities(caps(undefined))).toStrictEqual([]);
    expect(
      modelsFromCapabilities(
        caps([
          {
            id: "thought",
            category: "thought_level",
            type: "select",
            values: [{ value: "high" }],
          },
        ])
      )
    ).toStrictEqual([]);
  });

  // An in-flight warm may still fill the catalog, so `loading` is never
  // overwritten — the client keeps polling rather than latching a fallback.
  test("never overrides a loading catalog with the capability fallback", async () => {
    const s = await readHarnessesStatus({
      resolveModels: async () => ({ list: [], status: "loading" }),
      resolveCapabilities: async () =>
        caps([
          {
            id: "model",
            category: "model",
            type: "select",
            values: [{ value: "m-1" }],
          },
        ]),
    });
    for (const harness of s.harnesses) {
      expect(harness.modelsStatus).toBe("loading");
      expect(harness.models).toStrictEqual([]);
    }
  });

  test("a throwing resolver degrades that harness to an empty list", async () => {
    const s = await readHarnessesStatus({
      resolveModels: async (kind) => {
        if (kind === "codex") throw new Error("boom");
        return { list: [{ id: "ok" }], status: "ready" };
      },
    });
    const codex = s.harnesses.find((a) => a.kind === "codex");
    expect(codex?.models).toStrictEqual([]);
    expect(codex?.modelsStatus).toBe("empty");
    // One harness's failure never takes the rest of the list down with it.
    expect(s.harnesses.find((a) => a.kind === "opencode")?.modelsStatus).toBe(
      "ready"
    );
  });
});
