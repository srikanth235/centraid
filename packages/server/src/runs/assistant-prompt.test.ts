import { describe, expect, test } from "vitest";

import { buildAssistantPrompt } from "./assistant-prompt.js";

describe("assistant-prompt", () => {
  test("the register warns against claiming a write completed without calling vault_invoke", () => {
    const prompt = buildAssistantPrompt("My vault", "schema…");
    expect(prompt).toMatch(
      /never claim a write executed, was parked, or failed/iu
    );
    expect(prompt).toMatch(/destructive or irreversible/iu);
  });
});
