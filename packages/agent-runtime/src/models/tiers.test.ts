import { describe, expect, test } from "vitest";

import { HARNESS_TIERS, resolveClaudeModel } from "./tiers.js";

describe("tiers", () => {
  test("claude-code offers capability tiers with exactly one default", () => {
    const tiers = HARNESS_TIERS["claude-code"];
    expect(tiers && tiers.length > 0).toBeTruthy();
    expect(tiers!.filter((t) => t.default)).toHaveLength(1);
    const ids = tiers!.map((t) => t.id);
    expect(ids).toStrictEqual(["smart", "balanced", "fast"]);
  });

  test("codex is not given tiers (stays on gateway default)", () => {
    expect(HARNESS_TIERS.codex).toBeUndefined();
  });

  test("resolveClaudeModel maps tiers to CLI aliases, passes others through", () => {
    expect(resolveClaudeModel("smart")).toBe("opus");
    expect(resolveClaudeModel("balanced")).toBe("sonnet");
    expect(resolveClaudeModel("fast")).toBe("haiku");
    // Full ids / unknown tokens pass through unchanged.
    expect(resolveClaudeModel("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(resolveClaudeModel("")).toBe("");
  });
});
