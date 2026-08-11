/*
 * Per-call harness / model / configPins on `ctx.delegate` (issue #743 Part 2
 * item 5, absorbing #740).
 *
 * A handler names the harness, model, and config pins for one call; the fire's
 * own harness supplies the default. Naming is not constructing — a named
 * harness the user never authored is validated through `recordDerived` and
 * denied when that fails (#567 D13) — and a named harness that fails surfaces
 * its own typed failure rather than falling back to a different provider.
 * Split out of `run-automation-dispatch.test.ts` to keep both files under the
 * repo-hygiene line cap.
 */

import { describe, afterEach, expect, test } from "vitest";

import {
  ConversationStore,
  makeJournalDbProvider,
  ProviderEgressConsentStore,
} from "@centraid/app-engine";
import type {
  RunTurnFn,
  TurnConfig,
  TurnInput,
  TurnResult,
} from "@centraid/app-engine";
import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { HARNESSES } from "../registry.ts";
import type { HarnessKind } from "../types.ts";
import { startLiveDispatch } from "./run-automation-live-dispatch.ts";
import type { LiveDispatch } from "./run-automation-live-dispatch.ts";

/** Turns that passed through the host's accounted seam this test. */
let accountedTurns = 0;

/**
 * Stand-in for the gateway's `accountRunTurn(runTurn)`: the ONE driver the
 * host injects. It counts, then resolves the registry exactly as the real
 * accounted seam does — so a dispatch that reached a harness some other way
 * shows up as a harness call the counter never saw.
 */
const accountedRunTurn: RunTurnFn = (input, config) => {
  accountedTurns += 1;
  const spec = HARNESSES[config.prefs.kind];
  return spec.runTurn(input, config);
};

/** Restore any backend a test swapped out of the registry table. */
const restores: Array<() => void> = [];
const openDispatches: LiveDispatch[] = [];
describe("run-automation per-call harness suite", () => {
  afterEach(async () => {
    await forEachSequentially(openDispatches.splice(0), (dispatch) =>
      dispatch.close().catch(() => undefined)
    );
    for (const restore of restores.splice(0)) restore();
  });

  /**
   * Swap one backend's `runTurn` for a recording stub, mirroring the pattern
   * `registry.test.ts` uses. Returns the recorder.
   */
  function stubBackendRunTurn(
    kind: HarnessKind,
    impl: (
      input: TurnInput,
      config: TurnConfig
    ) => TurnResult | void | Promise<TurnResult | void>
  ): { calls: Array<{ input: TurnInput; config: TurnConfig }> } {
    const original = HARNESSES[kind];
    const calls: Array<{ input: TurnInput; config: TurnConfig }> = [];
    HARNESSES[kind] = {
      ...original,
      runTurn: async (input, config) => {
        calls.push({ input, config });
        const result = await impl(input, config);
        return result ?? { harnessKind: kind };
      },
    };
    restores.push(() => {
      HARNESSES[kind] = original;
    });
    return { calls };
  }

  async function openDispatch(
    harness: HarnessKind,
    model?: string
  ): Promise<LiveDispatch> {
    const workdir = await tempDir("centraid-automation-dispatch-");
    const journalDbFile = `${workdir}/journal.db`;
    const store = new ConversationStore(makeJournalDbProvider(journalDbFile));
    store.ensureAutomationConversation(
      "demo/nightly",
      "demo",
      "Nightly",
      harness
    );
    store.close();
    const dispatch = await startLiveDispatch({
      workdir,
      runId: "run-1",
      automationRef: "demo/nightly",
      journalDbFile,
      runTurn: accountedRunTurn,
      harness,
      ...(model ? { model } : {}),
      onLog: () => undefined,
    });
    openDispatches.push(dispatch);
    return dispatch;
  }

  const dispatchCtx = {
    runId: "run-1",
    automationId: "demo/nightly",
    abortSignal: new AbortController().signal,
  };

  /**
   * Open a dispatch surface wired to a real consent store over the fire's own
   * journal, so these tests exercise the durable rows rather than a fake.
   */
  async function openConsentedDispatch(opts: {
    harness: HarnessKind;
    ladderMembers: readonly HarnessKind[];
    consentSource?: "direct" | "ladder";
    seed?: (consent: ProviderEgressConsentStore) => void;
  }): Promise<{ dispatch: LiveDispatch; consent: ProviderEgressConsentStore }> {
    const workdir = await tempDir("centraid-automation-consent-");
    const journalDbFile = `${workdir}/journal.db`;
    const store = new ConversationStore(makeJournalDbProvider(journalDbFile));
    store.ensureAutomationConversation(
      "demo/nightly",
      "demo",
      "Nightly",
      opts.harness
    );
    store.close();
    const consent = new ProviderEgressConsentStore(
      makeJournalDbProvider(journalDbFile),
      (kind) => opts.ladderMembers.includes(kind)
    );
    opts.seed?.(consent);
    const dispatch = await startLiveDispatch({
      workdir,
      runId: "run-1",
      automationRef: "demo/nightly",
      journalDbFile,
      runTurn: accountedRunTurn,
      harness: opts.harness,
      providerEgressConsent: consent,
      ...(opts.consentSource ? { consentSource: opts.consentSource } : {}),
      onLog: () => undefined,
    });
    openDispatches.push(dispatch);
    return { dispatch, consent };
  }

  // ---- per-call harness/model/configPins (#743 Part 2 item c, absorbing #740) ----

  test("ctx.delegate({ harness, model, configPins }) drives the named harness+model with pins applied", async () => {
    const stub = stubBackendRunTurn("gemini", (input) => {
      input.onEvent({ type: "final", text: "answer" });
    });
    // The fire's own harness/model is codex/fire-model — the per-call args
    // must win over both.
    const { delegateDispatcher } = await openDispatch("codex", "fire-model");

    const answer = await delegateDispatcher(
      {
        prompt: "OCR this",
        harness: "gemini",
        model: "call-model",
        configPins: { thought_level: "low" },
      },
      dispatchCtx
    );

    expect(answer).toBe("answer");
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.config.prefs.kind).toBe("gemini");
    expect(stub.calls[0]?.input.model).toBe("call-model");
    expect(stub.calls[0]?.input.configPins).toStrictEqual({
      thought_level: "low",
    });
  });

  test("a per-call harness absent from the user's ladder is denied fail-closed, like an unauthored manifest pin", async () => {
    const stub = stubBackendRunTurn("gemini", (input) => {
      input.onEvent({ type: "final", text: "ok" });
    });
    // The fire itself runs on codex with direct consent; the handler names
    // gemini for one step, and gemini is nowhere in the user's live ladder —
    // exactly the shape a `requires.harness` pin the user never authored
    // would produce. `recordDerived` must refuse it the same way.
    const { dispatch, consent } = await openConsentedDispatch({
      harness: "codex",
      ladderMembers: ["claude-code"],
      consentSource: "direct",
    });

    await expect(
      dispatch.delegateDispatcher(
        { prompt: "go", harness: "gemini" },
        dispatchCtx
      )
    ).rejects.toThrow(/gemini/u);
    expect(stub.calls).toHaveLength(0);
    expect(consent.has("demo/nightly", "gemini", "automations")).toBe(false);
  });

  test("an explicit per-call harness that fails never falls back to the fire's own harness", async () => {
    const named = stubBackendRunTurn("claude-code", (input) => {
      input.onEvent({ type: "error", message: "quota", failureClass: "quota" });
    });
    const fireHarness = stubBackendRunTurn("codex", (input) => {
      input.onEvent({ type: "final", text: "should never run" });
    });
    const { delegateDispatcher } = await openDispatch("codex");

    await expect(
      delegateDispatcher({ prompt: "go", harness: "claude-code" }, dispatchCtx)
    ).rejects.toThrow(
      /centraid-delegate-failure:.*"harness":"claude-code".*"failureClass":"quota"/u
    );
    expect(named.calls).toHaveLength(1);
    expect(fireHarness.calls).toHaveLength(0);
  });

  test("repeating the same per-call harness across two calls resumes the same binding — no session handle needed", async () => {
    const claude = stubBackendRunTurn("claude-code", (input) => {
      input.onEvent({ type: "final", text: "answer" });
      return { harnessKind: "claude-code", sessionId: "session-claude-1" };
    });
    const { delegateDispatcher } = await openDispatch("codex");

    await delegateDispatcher(
      { prompt: "step one", harness: "claude-code" },
      dispatchCtx
    );
    await delegateDispatcher(
      { prompt: "step two", harness: "claude-code" },
      dispatchCtx
    );

    expect(claude.calls).toHaveLength(2);
    expect(claude.calls[0]?.input.prevSessionId).toBeUndefined();
    expect(claude.calls[1]?.input.prevSessionId).toBe("session-claude-1");
  });
});
