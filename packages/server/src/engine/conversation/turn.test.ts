import { describe, expect, test } from "vitest";

import { HARNESS_KINDS, isHarnessKind } from "./turn.js";

describe("turn", () => {
  test("HARNESS_KINDS is the source-of-truth list of harness kinds", () => {
    expect(HARNESS_KINDS).toStrictEqual([
      "codex",
      "claude-code",
      "gemini",
      "qwen",
      "opencode",
      "grok",
      "kimi",
      "copilot",
      "cursor",
      "kilo",
      "cline",
      "goose",
      "auggie",
      "vibe",
      "droid",
      "pi",
      "acp",
    ]);
  });

  test("isHarnessKind accepts every known kind", () => {
    for (const kind of HARNESS_KINDS) {
      expect(isHarnessKind(kind)).toBe(true);
    }
  });

  test("isHarnessKind rejects unknown / non-string values", () => {
    expect(isHarnessKind("gpt")).toBe(false);
    expect(isHarnessKind("")).toBe(false);
    expect(isHarnessKind("none")).toBe(false);
    expect(isHarnessKind(undefined)).toBe(false);
    expect(isHarnessKind(null)).toBe(false);
    expect(isHarnessKind(42)).toBe(false);
  });
});
