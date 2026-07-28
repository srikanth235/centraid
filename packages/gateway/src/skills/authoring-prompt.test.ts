// Authoring prompt composition (issue #545 B7).

import { describe, expect, test } from "vitest";

import { buildAuthoringExtraPrompt } from "./authoring-prompt.js";

describe("authoring-prompt", () => {
  test("buildAuthoringExtraPrompt for apps includes UI grounding after the base preamble", () => {
    const prompt = buildAuthoringExtraPrompt({
      baseExtra: "## App context\n\nid: notes",
      appKind: "app",
    });
    expect(prompt.startsWith("## App context")).toBe(true);
    expect(prompt).toContain("## Centraid app authoring");
    expect(prompt).toContain("Design tokens");
    // Blocks joined by blank lines.
    expect(prompt).toContain("\n\n");
  });

  test("buildAuthoringExtraPrompt for automations uses automation-authoring only", () => {
    const prompt = buildAuthoringExtraPrompt({
      baseExtra: "## Automation context",
      appKind: "automation",
    });
    expect(prompt).toContain("## Centraid automation authoring");
    expect(prompt).not.toContain("Design tokens");
    expect(prompt).not.toContain("## Centraid app authoring");
  });

  test("buildAuthoringExtraPrompt omits an empty base preamble", () => {
    const prompt = buildAuthoringExtraPrompt({ baseExtra: "", appKind: "app" });
    expect(prompt.startsWith("## Centraid app authoring")).toBe(true);
  });
});
