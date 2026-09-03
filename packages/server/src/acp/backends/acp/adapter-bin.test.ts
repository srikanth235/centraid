import { describe, expect, test } from "vitest";

import { resolveAdapterEntry } from "./adapter-bin.ts";

describe("adapter-bin", () => {
  test("resolves and memoizes a real adapter package bin entry", () => {
    const first = resolveAdapterEntry("@agentclientprotocol/claude-agent-acp");
    const second = resolveAdapterEntry("@agentclientprotocol/claude-agent-acp");
    expect(first).toBe(second);
    expect(first).toMatch(/claude-agent-acp/u);
    expect(first.endsWith(".js")).toBe(true);
  });

  test("throws an actionable error when the adapter package is not installed", () => {
    expect(() =>
      resolveAdapterEntry("@centraid/definitely-not-a-real-adapter")
    ).toThrow(/is not installed/u);
  });

  test("throws when the resolved package declares no bin entry", () => {
    expect(() => resolveAdapterEntry("ms")).toThrow(/declares no bin entry/u);
  });
});
