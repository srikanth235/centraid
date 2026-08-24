// Authoring prompt composition (issue #545 B7).

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
    // Blocks joined by blank lines.
    expect(prompt).toContain("\n\n");
  });

  test("buildAuthoringExtraPrompt for an app adds no authoring contract (#799)", () => {
    // App front ends are written in this repo, not authored by a harness: the
    // there is no app-authoring skill and no UI grounding, so an `app` turn
    // gets its preamble and nothing else.
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
