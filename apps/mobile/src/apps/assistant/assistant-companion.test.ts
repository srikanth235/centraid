import { describe, expect, it } from "vitest";

import {
  ASSISTANT_COMPANION_PRESENTATION,
  ASSISTANT_COMPANION_HEIGHT,
  ASSISTANT_COMPANION_TOUCH_TARGET,
  companionConsequence,
  companionPageContext,
  companionProviderLabel,
  companionSubmitText,
} from "./assistant-companion";

describe("Assistant companion", () => {
  it("is a bottom sheet rather than a replacement full-screen entry", () => {
    expect(ASSISTANT_COMPANION_PRESENTATION).toBe("bottom-sheet");
    expect(ASSISTANT_COMPANION_HEIGHT).toBe("86%");
    expect(ASSISTANT_COMPANION_TOUCH_TARGET).toBe(44);
  });

  it("trims a compact text turn and blocks empty or in-flight sends", () => {
    expect(companionSubmitText("  What needs me?  ", false)).toBe(
      "What needs me?"
    );
    expect(companionSubmitText("   ", false)).toBeUndefined();
    expect(companionSubmitText("Again", true)).toBeUndefined();
  });

  it("derives removable current-page context from the route beneath it", () => {
    expect(companionPageContext("Data")).toBe("Vault");
    expect(companionPageContext("Photos")).toBe("Photos");
    expect(companionPageContext(undefined)).toBe("Current page");
  });

  it("states the ledger consequence of context and attachments", () => {
    expect(
      companionConsequence("Vault", 2, {
        available: true,
        kind: "codex",
        label: "Codex",
      })
    ).toBe(
      "Codex sends what you ask and the inputs listed below to OpenAI. This turn includes Vault context and 2 attachments and is saved in your Assistant ledger."
    );
    expect(
      companionConsequence(undefined, 0, {
        available: false,
        kind: "claude-code",
        label: "Claude Code",
      })
    ).toBe("Claude Code is unavailable — choose an available harness to send.");
    expect(companionConsequence(undefined, 0, undefined)).toBe(
      "Checking the selected harness — nothing is sent yet."
    );
  });

  it("names the receiving vendor for every known harness and shared fallback", () => {
    expect(companionProviderLabel("codex", "Codex")).toBe("OpenAI");
    expect(companionProviderLabel("claude-code", "Claude Code")).toBe(
      "Anthropic"
    );
    expect(companionProviderLabel("gemini", "Gemini CLI")).toBe("Google");
    expect(companionProviderLabel("grok", "Grok")).toBe("xAI");
    expect(companionProviderLabel("local-tool", "Workshop")).toBe(
      "Workshop's configured provider"
    );
  });
});
