/*
 * Runner-core: turn-boundary failover + provider egress consent.
 *
 * Split from runner-core.test.ts (repo-hygiene 500-line cap): this file owns
 * the ladder loop — breaker-gated rung selection, per-rung resume/hydration
 * planning, and the attended cross-provider consent gate.
 */

import { describe, expect, it, vi } from "vitest";

import type { Dispatcher } from "../handlers/dispatcher.js";
import type { ProviderEgressConsentController } from "./provider-egress-consent.js";
import { makeConversationRunnerCore } from "./runner-core.js";
import type { ConversationTurnInput, TurnStreamEvent } from "./runner.js";
import type {
  RunTurnFn,
  HarnessPrefs,
  TurnConfig,
  TurnInput,
  TurnResult,
} from "./turn.js";

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

describe("makeConversationRunnerCore — turn-boundary failover", () => {
  it("settles a failed turn without replaying it through the next provider", async () => {
    const seen: Array<{ input: TurnInput; config: TurnConfig }> = [];
    const events: TurnStreamEvent[] = [];
    const runner = makeConversationRunnerCore({
      subsystem: "assistant",
      prefsLoader: async (_subsystem, kind) =>
        kind === "claude-code"
          ? { kind, configPins: { thought_level: "high" } }
          : { kind: "codex", configPins: { thought_level: "xhigh" } },
      harnessLadder: () => ["codex", "claude-code"],
      getDispatcher: () => dispatcher,
      providerEgressConsent: allowProviderEgress,
      resolveCwd: (input) => input.dataDir,
      runTurn: async (input, config) => {
        seen.push({ input, config });
        if (config.prefs.kind === "codex") {
          input.onEvent({
            type: "error",
            message: "quota exceeded",
            failureClass: "quota",
          });
          return { harnessKind: "codex" };
        }
        input.onEvent({ type: "final", text: "fallback answer" });
        return {
          harnessKind: "claude-code",
          sessionId: "claude-1",
          hydrated: true,
        };
      },
    });

    const result = await runner.run(
      turnInput({
        prevHarnessKind: "codex",
        prevHarnessSessionId: "codex-1",
        model: "gpt-codex",
        configPins: { model: "gpt-codex", thought_level: "xhigh" },
        hydrationContext: {
          prompt: "LEDGER",
          includedTurns: 3,
          omittedTurns: 0,
          estimatedTokens: 12,
        },
        onEvent: (event) => events.push(event),
      })
    );

    expect(seen.map((entry) => entry.config.prefs.kind)).toStrictEqual([
      "codex",
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "error", failureClass: "quota" })
    );
    expect(result).toMatchObject({ harnessKind: "codex" });
  });

  it("does not retry after meaningful output has begun", async () => {
    const kinds: HarnessPrefs["kind"][] = [];
    const events: TurnStreamEvent[] = [];
    const runner = makeConversationRunnerCore({
      subsystem: "assistant",
      prefsLoader: async (_subsystem, kind) => ({ kind: kind ?? "codex" }),
      harnessLadder: () => ["codex", "claude-code"],
      getDispatcher: () => dispatcher,
      providerEgressConsent: allowProviderEgress,
      resolveCwd: (input) => input.dataDir,
      runTurn: async (turn, config) => {
        kinds.push(config.prefs.kind);
        turn.onEvent({ type: "assistant.delta", delta: "partial" });
        turn.onEvent({
          type: "error",
          message: "harness exited",
          failureClass: "exit",
        });
        return { harnessKind: config.prefs.kind };
      },
    });

    await runner.run(turnInput({ onEvent: (event) => events.push(event) }));
    expect(kinds).toStrictEqual(["codex"]);
    expect(events.map((event) => event.type)).toStrictEqual([
      "assistant.delta",
      "error",
    ]);
  });

  it("skips a harness whose workspace breaker is open", async () => {
    const kinds: HarnessPrefs["kind"][] = [];
    const runner = makeConversationRunnerCore({
      subsystem: "assistant",
      prefsLoader: async (_subsystem, kind) => ({ kind: kind ?? "codex" }),
      harnessLadder: () => ["codex", "claude-code"],
      harnessHealth: {
        canAttempt: (_scope, kind) =>
          kind === "codex"
            ? {
                allowed: false,
                failureClass: "auth",
                breakerUntil: Date.now() + 1_000,
              }
            : { allowed: true },
        reportFailure: () => undefined,
        reportOk: () => undefined,
        reportPreflightOk: () => undefined,
        list: () => [],
      },
      getDispatcher: () => dispatcher,
      providerEgressConsent: allowProviderEgress,
      resolveCwd: (input) => input.dataDir,
      runTurn: async (_turn, config) => {
        kinds.push(config.prefs.kind);
        return { harnessKind: config.prefs.kind };
      },
    });

    await runner.run(turnInput());
    expect(kinds).toStrictEqual(["claude-code"]);
  });

  it("hydrates the rung it actually reaches, not the rung the route targeted", async () => {
    // Regression: resume + hydration used to be resolved ONCE against the
    // primary target. When rung 0 was skipped (breaker open) the fallback rung
    // inherited that plan — which, for an active primary sitting at the
    // ledger's head, is "no session id and no hydration". The whole
    // conversation silently vanished on the very turn a failover happened.
    const planned: HarnessPrefs["kind"][] = [];
    let seen: TurnInput | undefined;
    const runner = makeConversationRunnerCore({
      subsystem: "assistant",
      prefsLoader: async (_subsystem, kind) => ({ kind: kind ?? "codex" }),
      harnessLadder: () => ["codex", "claude-code"],
      harnessHealth: {
        canAttempt: (_scope, kind) =>
          kind === "codex"
            ? { allowed: false, failureClass: "auth" }
            : { allowed: true },
        reportFailure: () => undefined,
        reportOk: () => undefined,
        reportPreflightOk: () => undefined,
        list: () => [],
      },
      getDispatcher: () => dispatcher,
      providerEgressConsent: allowProviderEgress,
      resolveCwd: (input) => input.dataDir,
      runTurn: async (input, config) => {
        seen = input;
        return { harnessKind: config.prefs.kind };
      },
    });

    await runner.run(
      turnInput({
        prevHarnessKind: "codex",
        resumeForKind: (kind) => {
          planned.push(kind);
          // The primary is caught up (nothing to replay); the fallback has
          // never seen this conversation and needs the whole ledger.
          return kind === "codex"
            ? { sessionId: "codex-session", bindingId: "binding-codex" }
            : {
                hydrationContext: {
                  prompt: "earlier turns",
                  includedTurns: 3,
                  omittedTurns: 0,
                  estimatedTokens: 42,
                },
              };
        },
      })
    );

    // Only the rung actually attempted is planned — no wasted ledger folds.
    expect(planned).toStrictEqual(["claude-code"]);
    expect(seen?.prevSessionId).toBeUndefined();
    expect(seen?.hydrationContext).toBe("earlier turns");
    expect(seen?.forceHydration).toBe(true);
  });

  it("names the agents it consulted and carries the breaker failure class", async () => {
    const events: TurnStreamEvent[] = [];
    const runner = makeConversationRunnerCore({
      subsystem: "assistant",
      prefsLoader: async () => ({ kind: "codex" }),
      harnessHealth: {
        canAttempt: () => ({ allowed: false, failureClass: "auth" }),
        reportFailure: () => undefined,
        reportOk: () => undefined,
        reportPreflightOk: () => undefined,
        list: () => [],
      },
      getDispatcher: () => dispatcher,
      providerEgressConsent: allowProviderEgress,
      resolveCwd: (input) => input.dataDir,
      runTurn: async () => ({ harnessKind: "codex" }),
    });

    await runner.run(turnInput({ onEvent: (event) => events.push(event) }));
    const error = events.find((event) => event.type === "error");
    expect(error).toMatchObject({ failureClass: "auth" });
    expect((error as { message: string }).message).toContain("codex");
    expect((error as { message: string }).message).not.toContain(
      "Every configured harness"
    );
  });
});

describe("makeConversationRunnerCore — provider egress consent", () => {
  it("implicitly grants the initial choice and gates an attended cross-provider switch", async () => {
    const grants = new Set<string>();
    const runTurn = vi.fn<RunTurnFn>(
      async (): Promise<TurnResult> => ({ harnessKind: "codex" })
    );
    const events: TurnStreamEvent[] = [];
    const runner = makeConversationRunnerCore({
      subsystem: "assistant",
      prefsLoader: async () => ({ kind: "codex" }),
      providerEgressConsent: {
        has: (conversationId, harnessKind) =>
          grants.has(`${conversationId}:${harnessKind}`),
        grant: (conversationId, harnessKind) =>
          grants.add(`${conversationId}:${harnessKind}`),
        revoke: (conversationId, harnessKind) =>
          grants.delete(`${conversationId}:${harnessKind}`),
      },
      getDispatcher: () => dispatcher,
      resolveCwd: (input) => input.dataDir,
      runTurn,
    });

    await runner.run(turnInput({ onEvent: (event) => events.push(event) }));
    expect(runTurn).toHaveBeenCalledOnce();
    expect(grants.has("conv-1:codex")).toBe(true);

    await runner.run(
      turnInput({
        harnessKind: "claude-code",
        prevHarnessKind: "codex",
        onEvent: (event) => events.push(event),
      })
    );
    expect(runTurn).toHaveBeenCalledOnce();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "consent.required",
        consentKind: "provider-egress",
        provider: "claude-code",
      })
    );

    await runner.run(
      turnInput({
        harnessKind: "claude-code",
        prevHarnessKind: "codex",
        providerConsent: "claude-code",
        onEvent: (event) => events.push(event),
      })
    );
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(grants.has("conv-1:claude-code")).toBe(true);
  });

  it("accepts an accumulated consent set, not just the single newest provider", async () => {
    // The client re-sends every provider the owner has approved on this
    // conversation, so switching back to an earlier one does not re-prompt.
    const grants = new Set<string>();
    const runTurn = vi.fn<RunTurnFn>(
      async (): Promise<TurnResult> => ({ harnessKind: "gemini" })
    );
    const events: TurnStreamEvent[] = [];
    const runner = makeConversationRunnerCore({
      subsystem: "assistant",
      prefsLoader: async (_subsystem, kind) => ({ kind: kind ?? "codex" }),
      providerEgressConsent: {
        has: (conversationId, harnessKind) =>
          grants.has(`${conversationId}:${harnessKind}`),
        grant: (conversationId, harnessKind) =>
          grants.add(`${conversationId}:${harnessKind}`),
        revoke: (conversationId, harnessKind) =>
          grants.delete(`${conversationId}:${harnessKind}`),
      },
      getDispatcher: () => dispatcher,
      resolveCwd: (input) => input.dataDir,
      runTurn,
    });

    await runner.run(
      turnInput({
        harnessKind: "gemini",
        prevHarnessKind: "codex",
        providerConsent: ["claude-code", "gemini"],
        onEvent: (event) => events.push(event),
      })
    );
    expect(runTurn).toHaveBeenCalledOnce();
    expect(grants.has("conv-1:gemini")).toBe(true);
    expect(events.some((event) => event.type === "consent.required")).toBe(
      false
    );
  });

  it("treats an explicitly configured ladder rung as recorded subsystem consent", async () => {
    const granted: Array<[string, HarnessPrefs["kind"], string]> = [];
    const runTurn = vi.fn<RunTurnFn>(
      async (_input: TurnInput, config: TurnConfig): Promise<TurnResult> => ({
        harnessKind: config.prefs.kind,
      })
    );
    const runner = makeConversationRunnerCore({
      subsystem: "assistant",
      prefsLoader: async (_subsystem, kind) => ({ kind: kind ?? "codex" }),
      harnessLadder: () => ["codex", "claude-code"],
      harnessHealth: {
        canAttempt: (_scope, kind) =>
          kind === "codex"
            ? { allowed: false, failureClass: "auth" }
            : { allowed: true },
        reportFailure: () => undefined,
        reportOk: () => undefined,
        reportPreflightOk: () => undefined,
        list: () => [],
      },
      providerEgressConsent: {
        has: (conversationId, kind) =>
          granted.some(([savedConversation, savedKind]) => {
            return savedConversation === conversationId && savedKind === kind;
          }),
        grant: (conversationId, kind, source) =>
          granted.push([conversationId, kind, source]),
        revoke: () => undefined,
      },
      getDispatcher: () => dispatcher,
      resolveCwd: (input) => input.dataDir,
      runTurn,
    });

    await runner.run(turnInput({ prevHarnessKind: "codex" }));
    expect(runTurn).toHaveBeenCalledOnce();
    expect(runTurn.mock.calls[0]![1].prefs.kind).toBe("claude-code");
    expect(granted).toContainEqual(["conv-1", "claude-code", "ladder"]);
  });
});
