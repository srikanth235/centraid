import { describe, expect, test } from "vitest";

import { buildAssistantPrompt } from "./assistant-prompt.js";

// The prompt must guard writes and parking, not just outbox sends: without
// that guard an agent claims a destructive purge completed without ever
// calling `vault_invoke` (observed in real-app E2E). This assertion covers the
// vault assistant and the per-app kit-ask register alike (both share REGISTER).
describe("assistant-prompt", () => {
  test("the register warns against claiming a write completed without calling vault_invoke", () => {
    const prompt = buildAssistantPrompt("My vault", "schema…");
    expect(prompt).toMatch(
      /never claim a write executed, was parked, or failed/iu
    );
    expect(prompt).toMatch(/destructive or irreversible/iu);
  });
});
