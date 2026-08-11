import { describe, expect, it } from "vitest";

import {
  removedHarnessLadderMembers,
  resolveGatewayHarnessPrefs,
  resolveStrictGatewayHarnessPrefs,
} from "./harness-prefs.js";

describe(resolveGatewayHarnessPrefs, () => {
  const prefs = {
    "agent.harness.kind": "codex",
    "agent.harness.binPath": "/custom/codex",
    "agent.harness.extraArgs": ["--codex-profile", 42],
    "harness.automations": "claude-code",
    "config.codex.default.thought_level": "medium",
    "config.claude-code.default.thought_level": "low",
    "config.claude-code.automations.thought_level": "high",
  };

  it("keeps custom launch settings only for their configured harness", () => {
    expect(resolveGatewayHarnessPrefs(prefs)).toStrictEqual({
      kind: "codex",
      binPath: "/custom/codex",
      extraArgs: ["--codex-profile"],
    });
  });

  it("uses registry launch defaults for a different manifest-requested harness", () => {
    expect(
      resolveGatewayHarnessPrefs(prefs, "automations", "claude-code")
    ).toStrictEqual({
      kind: "claude-code",
      configPins: { thought_level: "high" },
    });
  });

  it("also isolates a subsystem pin from the default harness launch settings", () => {
    expect(resolveGatewayHarnessPrefs(prefs, "automations")).toStrictEqual({
      kind: "claude-code",
      configPins: { thought_level: "high" },
    });
  });
});

describe(removedHarnessLadderMembers, () => {
  it("reports removal from one subsystem even when another ladder retains the harness", () => {
    const before = {
      "agent.harness.kind": "codex",
      "harness.ladder.assistant": ["claude-code"],
      "harness.ladder.automations": ["claude-code"],
    };
    const after = {
      ...before,
      "harness.ladder.assistant": [],
    };

    expect(removedHarnessLadderMembers(before, after)).toStrictEqual([
      { subsystem: "assistant", kind: "claude-code" },
    ]);
  });

  it("resolves default-ladder membership independently for every subsystem", () => {
    const before = {
      "agent.harness.kind": "codex",
      "harness.ladder.default": ["claude-code"],
      "harness.ladder.assistant": ["claude-code"],
    };
    const after = {
      ...before,
      "harness.ladder.default": [],
    };

    expect(removedHarnessLadderMembers(before, after)).toStrictEqual([
      { subsystem: "ask", kind: "claude-code" },
      { subsystem: "builder", kind: "claude-code" },
      { subsystem: "automations", kind: "claude-code" },
    ]);
  });

  it("rejects an unregistered harness instead of coercing it to the default", () => {
    // The live-turn resolver must still hand back a usable harness…
    expect(
      resolveGatewayHarnessPrefs(
        { "harness.automations": "future-harness" },
        "automations"
      ).kind
    ).toBe("codex");
    // …but the Settings patch path must not persist a choice this host cannot
    // execute under a name that silently means `codex`.
    expect(
      resolveStrictGatewayHarnessPrefs(
        { "harness.automations": "future-harness" },
        "automations"
      )
    ).toBeUndefined();
    expect(
      resolveStrictGatewayHarnessPrefs({
        "agent.harness.kind": "future-harness",
      })
    ).toBeUndefined();
    // Unset means "the default agent" and stays valid.
    expect(resolveStrictGatewayHarnessPrefs({}, "automations")?.kind).toBe(
      "codex"
    );
    expect(
      resolveStrictGatewayHarnessPrefs(
        { "harness.automations": "claude-code" },
        "automations"
      )?.kind
    ).toBe("claude-code");
  });
});
