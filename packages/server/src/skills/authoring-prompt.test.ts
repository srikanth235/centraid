import { describe, expect, test } from "vitest";

import { buildAuthoringExtraPrompt } from "./authoring-prompt.js";

describe("authoring-prompt", () => {
  test("buildAuthoringExtraPrompt for automations uses automation-authoring", () => {
    const prompt = buildAuthoringExtraPrompt({
      baseExtra: "## Automation context",
      appKind: "automation",
    });
    expect(prompt.startsWith("## Automation context")).toBe(true);
    expect(prompt).toContain("## Centraid automation authoring");
    expect(prompt).toContain("\n\n");
  });

  test("buildAuthoringExtraPrompt for an app adds no authoring contract (#799)", () => {
    const prompt = buildAuthoringExtraPrompt({
      baseExtra: "## App context\n\nid: notes",
      appKind: "app",
    });
    expect(prompt).toBe("## App context\n\nid: notes");
  });

  test("buildAuthoringExtraPrompt omits an empty base preamble", () => {
    const prompt = buildAuthoringExtraPrompt({
      baseExtra: "",
      appKind: "automation",
    });
    expect(prompt.startsWith("## Centraid automation authoring")).toBe(true);
  });
});
