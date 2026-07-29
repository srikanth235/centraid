import { describe, expect, it, vi } from "vitest";

import type { AssistantConfig } from "../../lib/assistant";
import type * as TypeImport_qayssx from "../../lib/assistant";

const assistant = vi.hoisted(() => ({
  saveAssistantSelection:
    vi.fn<typeof TypeImport_qayssx.saveAssistantSelection>(),
}));

vi.mock(import("../../lib/assistant"), () => ({
  saveAssistantSelection: assistant.saveAssistantSelection,
}));

const {
  nextProviderConsent,
  persistAssistantSelection,
  preflightedRunnerSelection,
} = await import("./useAssistant");

function config(over: Partial<AssistantConfig> = {}): AssistantConfig {
  return {
    runners: [
      {
        kind: "codex",
        label: "Codex",
        available: true,
        models: [],
        selectedModel: "",
        efforts: [],
        selectedEffort: "",
        supportsAttachments: true,
        supportsContext: true,
        sessionReady: true,
      },
    ],
    runnerKind: "codex",
    models: [],
    selectedModel: "",
    efforts: [],
    selectedEffort: "",
    supportsAttachments: true,
    supportsContext: true,
    ...over,
  };
}

describe("nextProviderConsent", () => {
  it("keeps earlier approvals when a consent-gated failover asks for another provider", () => {
    const first = nextProviderConsent(undefined, "claude-code");
    expect(first).toStrictEqual(["claude-code"]);
    expect(nextProviderConsent(first, "copilot")).toStrictEqual([
      "claude-code",
      "copilot",
    ]);
  });

  it("does not repeat a provider the owner already approved", () => {
    expect(nextProviderConsent(["codex"], "codex")).toStrictEqual(["codex"]);
  });
});

describe("preflightedRunnerSelection", () => {
  it("retains the prior runner when refreshed session setup or sign-in is incomplete", () => {
    const current = config();
    const fresh = config({
      runners: [
        ...current.runners,
        {
          kind: "claude-code",
          label: "Claude Code",
          available: true,
          models: [],
          selectedModel: "",
          efforts: [],
          selectedEffort: "",
          supportsAttachments: false,
          supportsContext: false,
          sessionReady: false,
          hint: "Sign in to Claude Code.",
        },
      ],
    });
    const result = preflightedRunnerSelection(current, fresh, "claude-code");
    expect(result.config).toBe(current);
    expect(result.error).toBe("Sign in to Claude Code.");
  });

  it("turns a failed model preference write into a surfaced error result", async () => {
    assistant.saveAssistantSelection.mockRejectedValueOnce(
      new Error("prefs unavailable")
    );
    await expect(
      persistAssistantSelection("codex", "model", "gpt-5")
    ).resolves.toStrictEqual({
      ok: false,
      error: "prefs unavailable",
    });
  });
});
