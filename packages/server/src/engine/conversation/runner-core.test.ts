import { describe, expect, it, vi } from "vitest";

import type { Dispatcher } from "../handlers/dispatcher.js";
import type { ModelSubsystem } from "../stores/prefs-store.js";
import type { ProviderEgressConsentController } from "./provider-egress-consent.js";
import { makeConversationRunnerCore } from "./runner-core.js";
import type { ConversationRunnerCoreOptions } from "./runner-core.js";
import type { ConversationTurnInput } from "./runner.js";
import type { HarnessPrefs, RunTurnFn, TurnInput } from "./turn.js";

type PrefsLoader = ConversationRunnerCoreOptions["prefsLoader"];

const dispatcher = {} as Dispatcher;
const allowProviderEgress: ProviderEgressConsentController = {
  has: () => true,
  grant: () => undefined,
  revoke: () => undefined,
};

function turnInput(
  over: Partial<ConversationTurnInput> = {}
): ConversationTurnInput {
  return {
    appId: "demo",
    dataDir: "/tmp/demo",
    conversationId: "conv-1",
    sessionFile: "/tmp/demo/conv-1.jsonl",
    message: "hi",
    extraSystemPrompt: "preamble",
    abortSignal: new AbortController().signal,
    onEvent: () => undefined,
    ...over,
  };
}

function build(opts: { prefsLoader: PrefsLoader; subsystem?: ModelSubsystem }) {
  const seen: TurnInput[] = [];
  const runTurn = vi.fn<RunTurnFn>(async (input) => {
    seen.push(input);
    return { harnessKind: "codex", sessionId: "new-session" };
  });
  const runner = makeConversationRunnerCore({
    prefsLoader: opts.prefsLoader,
    ...(opts.subsystem ? { subsystem: opts.subsystem } : {}),
    getDispatcher: () => dispatcher,
    providerEgressConsent: allowProviderEgress,
    resolveCwd: (input) => input.dataDir,
    runTurn,
  });
  return { runner, seen, runTurn };
}

describe("makeConversationRunnerCore — provider-egress boundary", () => {
  it("fails closed when a host omits the provider-egress controller", () => {
    expect(() =>
      makeConversationRunnerCore({
        prefsLoader: async () => ({ kind: "codex" }),
        getDispatcher: () => dispatcher,
        providerEgressConsent: undefined as never,
        resolveCwd: (input) => input.dataDir,
        runTurn: async () => ({ harnessKind: "codex" }),
      })
    ).toThrow("requires provider-egress consent");
  });
});

describe("makeConversationRunnerCore — per-subsystem prefs loading", () => {
  it("passes the register's subsystem to the prefs loader on every turn", async () => {
    const prefsLoader = vi.fn<PrefsLoader>(async () => ({
      kind: "claude-code" as const,
    }));
    const { runner } = build({ prefsLoader, subsystem: "ask" });

    await runner.run(turnInput());
    await runner.run(turnInput());

    expect(prefsLoader).toHaveBeenCalledTimes(2);
    expect(prefsLoader).toHaveBeenNthCalledWith(1, "ask");
    expect(prefsLoader).toHaveBeenNthCalledWith(2, "ask");
  });

  it("calls the loader bare when the register has no subsystem (back-compat)", async () => {
    const prefsLoader = vi.fn<PrefsLoader>(async () => ({
      kind: "codex" as const,
    }));
    const { runner } = build({ prefsLoader });

    await runner.run(turnInput());

    expect(prefsLoader).toHaveBeenCalledWith(undefined);
  });

  it("picks up a harness re-pin mid-session, with no restart", async () => {
    let kind: HarnessPrefs["kind"] = "codex";
    const { runner, runTurn } = build({
      prefsLoader: async () => ({ kind }),
      subsystem: "assistant",
    });

    await runner.run(turnInput());
    expect(runTurn.mock.calls[0]![1]).toStrictEqual({
      prefs: { kind: "codex" },
    });

    kind = "claude-code";
    await runner.run(turnInput());
    expect(runTurn.mock.calls[1]![1]).toStrictEqual({
      prefs: { kind: "claude-code" },
    });
  });

  it("lets a validated automation turn override only the loaded harness kind", async () => {
    const prefsLoader = vi.fn<PrefsLoader>(
      async (_subsystem?: ModelSubsystem, requested?: HarnessPrefs["kind"]) =>
        requested === "claude-code"
          ? {
              kind: "claude-code" as const,
              binPath: "/configured/claude",
              extraArgs: ["--profile", "work"],
            }
          : { kind: "codex" as const, binPath: "/configured/codex" }
    );
    const { runner, runTurn } = build({
      prefsLoader,
      subsystem: "automations",
    });

    await runner.run(
      turnInput({ harnessKind: "claude-code", model: "claude-custom" })
    );

    expect(runTurn.mock.calls[0]![1]).toStrictEqual({
      prefs: {
        kind: "claude-code",
        binPath: "/configured/claude",
        extraArgs: ["--profile", "work"],
      },
    });
    expect(prefsLoader).toHaveBeenCalledWith("automations", "claude-code");
    expect(runTurn.mock.calls[0]![0].model).toBe("claude-custom");
  });

  it("drops another harness's launch settings when a legacy loader ignores the override", async () => {
    const { runner, runTurn } = build({
      prefsLoader: async () => ({
        kind: "codex",
        binPath: "/configured/codex",
        extraArgs: ["--codex-only"],
      }),
      subsystem: "automations",
    });

    await runner.run(turnInput({ harnessKind: "claude-code" }));

    expect(runTurn.mock.calls[0]![1]).toStrictEqual({
      prefs: { kind: "claude-code" },
    });
  });
});

describe("makeConversationRunnerCore — hydration accounting", () => {
  it("returns the estimated tokens of the plan the harness actually consumed", async () => {
    const runner = makeConversationRunnerCore({
      prefsLoader: async () => ({ kind: "codex" }),
      getDispatcher: () => dispatcher,
      providerEgressConsent: allowProviderEgress,
      resolveCwd: (input) => input.dataDir,
      runTurn: async () => ({
        harnessKind: "codex",
        sessionId: "fresh",
        hydrated: true,
        hydrationKind: "recovery",
      }),
    });
    const result = await runner.run(
      turnInput({
        prevHarnessKind: "codex",
        prevHarnessSessionId: "expired",
        hydrationContext: {
          prompt: "delta",
          includedTurns: 1,
          omittedTurns: 0,
          estimatedTokens: 10,
        },
        recoveryHydrationContext: {
          prompt: "full",
          includedTurns: 4,
          omittedTurns: 0,
          estimatedTokens: 40,
        },
      })
    );
    expect(result).toMatchObject({
      hydrated: true,
      hydrationTokens: 40,
    });
  });
});

describe("makeConversationRunnerCore — session resume gating", () => {
  it("resumes when the previous turn used the same harness kind", async () => {
    const { runner, seen } = build({
      prefsLoader: async () => ({ kind: "codex" }),
      subsystem: "assistant",
    });

    await runner.run(
      turnInput({
        prevHarnessKind: "codex",
        prevHarnessSessionId: "thread-abc",
      })
    );

    expect(seen[0]!.prevSessionId).toBe("thread-abc");
  });

  it("forwards the persisted usage baseline only with its matching session", async () => {
    const { runner, seen } = build({
      prefsLoader: async () => ({ kind: "codex" }),
      subsystem: "assistant",
    });
    const snapshot = {
      inputTokens: 90,
      cost: { amount: 0.2, currency: "USD" },
    };

    await runner.run(
      turnInput({
        prevHarnessKind: "codex",
        prevHarnessSessionId: "thread-abc",
        prevHarnessUsageSnapshot: snapshot,
      })
    );

    expect(seen[0]!.prevUsageSnapshot).toStrictEqual(snapshot);
  });

  it("invalidates the session when the subsystem's harness has changed", async () => {
    const { runner, seen } = build({
      prefsLoader: async () => ({ kind: "claude-code" }),
      subsystem: "assistant",
    });

    await runner.run(
      turnInput({
        prevHarnessKind: "codex",
        prevHarnessSessionId: "thread-abc",
      })
    );

    expect(seen[0]!.prevSessionId).toBeUndefined();
    expect(seen[0]!.prevUsageSnapshot).toBeUndefined();
  });

  it("invalidates independently per subsystem", async () => {
    const ask = build({
      prefsLoader: async () => ({ kind: "claude-code" }),
      subsystem: "ask",
    });
    const builder = build({
      prefsLoader: async () => ({ kind: "codex" }),
      subsystem: "builder",
    });
    const prior = {
      prevHarnessKind: "codex",
      prevHarnessSessionId: "thread-abc",
    };

    await ask.runner.run(turnInput(prior));
    await builder.runner.run(turnInput(prior));

    expect(ask.seen[0]!.prevSessionId).toBeUndefined();
    expect(builder.seen[0]!.prevSessionId).toBe("thread-abc");
  });

  it("starts fresh when there is no prior session at all", async () => {
    const { runner, seen } = build({
      prefsLoader: async () => ({ kind: "codex" }),
      subsystem: "assistant",
    });

    await runner.run(turnInput());

    expect(seen[0]!.prevSessionId).toBeUndefined();
  });
});
