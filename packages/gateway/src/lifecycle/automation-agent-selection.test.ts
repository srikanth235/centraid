import { describe, expect, it } from "vitest";

import {
  resolveAutomationAgentSelection,
  resolveAutomationRewriteModel,
} from "./automation-agent-selection.js";

describe(resolveAutomationAgentSelection, () => {
  const prefs = {
    "model.codex.automations": "codex-auto",
    "model.claude-code.automations": "claude-auto",
    "model.claude-code.default": "claude-default",
    "config.claude-code.default.thought_level": "medium",
    "config.claude-code.automations.thought_level": "high",
  };

  it("gives valid manifest harness/model pins priority over subsystem prefs", () => {
    expect(
      resolveAutomationAgentSelection(
        { harness: "claude-code", model: "claude-explicit" },
        prefs,
        "codex"
      )
    ).toStrictEqual({
      harness: "claude-code",
      // The manifest named a provider the user's automations lane does not
      // use, so this selection is not consent for unattended egress (#567).
      selectionSource: "manifest",
      model: "claude-explicit",
      configPins: { thought_level: "high" },
    });
  });

  it("falls back from an unregistered open key and scopes model prefs to that fallback", () => {
    expect(
      resolveAutomationAgentSelection(
        { harness: "future-harness" },
        prefs,
        "codex"
      )
    ).toStrictEqual({
      harness: "codex",
      // Falling back lands on the user's own automations harness.
      selectionSource: "prefs",
      model: "codex-auto",
    });
  });

  it("uses the pinned harness subsystem model when no model is explicit", () => {
    expect(
      resolveAutomationAgentSelection(
        { harness: "claude-code" },
        prefs,
        "codex"
      )
    ).toStrictEqual({
      harness: "claude-code",
      selectionSource: "manifest",
      model: "claude-auto",
      configPins: { thought_level: "high" },
    });
  });

  it("reports a manifest pin that names the user own harness as prefs-authored", () => {
    expect(
      resolveAutomationAgentSelection(
        { harness: "claude-code" },
        prefs,
        "claude-code"
      )
    ).toMatchObject({ harness: "claude-code", selectionSource: "prefs" });
  });

  it("gives a manifest thought-level pin priority over prefs", () => {
    expect(
      resolveAutomationAgentSelection(
        { harness: "claude-code", thoughtLevel: "max" },
        prefs,
        "codex"
      )
    ).toMatchObject({ configPins: { thought_level: "max" } });
  });

  it("keeps an explicit automation model ahead of rewrite and catalog defaults", () => {
    expect(
      resolveAutomationRewriteModel(
        { harness: "claude-code", model: "claude-explicit" },
        { harness: "claude-code", model: "claude-explicit" },
        "claude-rewrite",
        "claude-fast"
      )
    ).toBe("claude-explicit");
  });

  it("uses the rewrite tier only when the automation has no explicit model", () => {
    expect(
      resolveAutomationRewriteModel(
        { harness: "claude-code" },
        { harness: "claude-code", model: "claude-automation-default" },
        "claude-rewrite",
        "claude-fast"
      )
    ).toBe("claude-rewrite");
  });
});
