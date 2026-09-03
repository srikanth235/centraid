import { describe, afterEach, expect, test } from "vitest";

import {
  ConversationStore,
  makeLedgerDbProvider,
} from "@centraid/server/engine";
import type {
  ProviderEgressConsentController,
  RunTurnFn,
  TurnConfig,
  TurnInput,
  TurnResult,
  TurnStreamEvent,
} from "@centraid/server/engine";
import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { ledgerDbFileIn } from "../../engine/stores/ledger-db.test-fixtures.js";
import { HARNESSES } from "../registry.ts";
import { runTurn } from "../runtime.ts";
import type { HarnessKind } from "../types.ts";
import {
  parseAutomationDelegateFailure,
  startLiveDispatch,
} from "./run-automation-live-dispatch.ts";
import type { LiveDispatch } from "./run-automation-live-dispatch.ts";

const ACP_KINDS = [
  "gemini",
  "qwen",
  "acp",
] as const satisfies readonly HarnessKind[];

const restores: Array<() => void> = [];
const openDispatches: LiveDispatch[] = [];
const allowProviderEgress: ProviderEgressConsentController = {
  has: () => true,
  grant: () => undefined,
  revoke: () => undefined,
};
describe("run-automation-dispatch suite", () => {
  afterEach(async () => {
    await forEachSequentially(openDispatches.splice(0), (dispatch) =>
      dispatch.close().catch(() => undefined)
    );
    for (const restore of restores.splice(0)) restore();
  });

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
    const ledgerDbFile = ledgerDbFileIn(workdir);
    const store = new ConversationStore(makeLedgerDbProvider(ledgerDbFile));
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
      ledgerDbFile,
      runTurn,
      harness,
      providerEgressConsent: allowProviderEgress,
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

  test("the dispatch surface exposes only ctx.delegate — no tool dispatcher, nothing eager", async () => {
    const dispatch = await openDispatch("codex");
    expect(dispatch).not.toHaveProperty("toolDispatcher");
    expect(dispatch.delegateDispatcher).toBeTypeOf("function");
    expect(dispatch.close).toBeTypeOf("function");
  });

  test("ctx.delegate fails closed before harness dispatch when the host omits the consent controller", async () => {
    const stub = stubBackendRunTurn("codex", (input) => {
      input.onEvent({ type: "final", text: "must not run" });
    });
    const workdir = await tempDir("centraid-automation-missing-consent-");
    const ledgerDbFile = ledgerDbFileIn(workdir);
    const store = new ConversationStore(makeLedgerDbProvider(ledgerDbFile));
    store.ensureAutomationConversation(
      "demo/nightly",
      "demo",
      "Nightly",
      "codex"
    );
    store.close();
    const dispatch = await startLiveDispatch({
      workdir,
      runId: "run-missing-consent",
      automationRef: "demo/nightly",
      ledgerDbFile,
      runTurn,
      harness: "codex",
      providerEgressConsent: undefined as never,
      onLog: () => undefined,
    });
    openDispatches.push(dispatch);

    await expect(
      dispatch.delegateDispatcher({ prompt: "do not egress" }, dispatchCtx)
    ).rejects.toThrow(/did not provide a provider-egress consent controller/u);
    expect(stub.calls).toHaveLength(0);
  });

  test.each(ACP_KINDS)(
    "ctx.delegate on %s drives the registered harness",
    async (kind) => {
      const stub = stubBackendRunTurn(kind, (input) => {
        input.onEvent({ type: "assistant.start" });
        input.onEvent({ type: "final", text: "answer from the ACP harness" });
      });

      const { delegateDispatcher } = await openDispatch(kind, "some-model");
      const forwarded: TurnStreamEvent[] = [];
      const answer = await delegateDispatcher(
        { prompt: "summarise the inbox", onEvent: (ev) => forwarded.push(ev) },
        dispatchCtx
      );

      expect(answer).toBe("answer from the ACP harness");
      expect(stub.calls).toHaveLength(1);
      const [call] = stub.calls;
      expect(call?.input.message).toBe("summarise the inbox");
      expect(call?.input.model).toBe("some-model");
      expect(call?.config.prefs.kind).toBe(kind);
      expect(forwarded.map((e) => e.type)).toStrictEqual([
        "assistant.start",
        "final",
      ]);
    }
  );

  test("ctx.delegate coerces the ACP final text against the requested JSON shape", async () => {
    stubBackendRunTurn("gemini", (input) => {
      input.onEvent({ type: "final", text: '{"count": 3}' });
    });

    const { delegateDispatcher } = await openDispatch("gemini");
    const answer = await delegateDispatcher(
      {
        prompt: "count them",
        json: { type: "object", properties: { count: { type: "number" } } },
      },
      dispatchCtx
    );

    expect(answer).toStrictEqual({ count: 3 });
  });

  test("automation attachments stay on the ACP capability-gated attachment rail", async () => {
    const stub = stubBackendRunTurn("gemini", (input) => {
      input.onEvent({ type: "final", text: "visible text" });
    });
    const { delegateDispatcher } = await openDispatch("gemini");

    await delegateDispatcher(
      {
        prompt: "read the photograph",
        attachments: [
          {
            name: "receipt.jpg",
            mediaType: "image/jpeg",
            base64: Buffer.from("image-bytes").toString("base64"),
          },
        ],
      },
      dispatchCtx
    );

    expect(stub.calls[0]?.input.message).toBe("read the photograph");
    expect(stub.calls[0]?.input.attachments).toStrictEqual([
      expect.objectContaining({
        mime: "image/jpeg",
        filename: "receipt.jpg",
        path: expect.stringContaining(".automation-scratch"),
      }),
    ]);
  });

  test("ctx.delegate surfaces an ACP harness error that produced no text", async () => {
    stubBackendRunTurn("acp", (input) => {
      input.onEvent({ type: "error", message: "no binary configured" });
    });

    const { delegateDispatcher } = await openDispatch("acp");
    await expect(
      delegateDispatcher({ prompt: "go" }, dispatchCtx)
    ).rejects.toThrow(
      /centraid-delegate-failure:.*"harness":"acp".*"message":"no binary configured"/u
    );
  });

  test("typed automation failures survive a handler-worker stack suffix", async () => {
    expect(
      parseAutomationDelegateFailure(
        'Error: centraid-delegate-failure:{"harness":"codex","failureClass":"spawn","message":"missing"}\n' +
          "    at MessagePort.<anonymous> (harness.js:71:25)"
      )
    ).toStrictEqual({
      harness: "codex",
      failureClass: "spawn",
      message: "missing",
    });
  });

  test("ctx.delegate never retries another provider inside the same turn", async () => {
    const primary = stubBackendRunTurn("codex", (input) => {
      input.onEvent({ type: "error", message: "quota", failureClass: "quota" });
    });
    const fallback = stubBackendRunTurn("claude-code", (input) => {
      input.onEvent({ type: "final", text: "fallback answer" });
    });
    const workdir = await tempDir("centraid-automation-failover-");
    const ledgerDbFile = ledgerDbFileIn(workdir);
    const store = new ConversationStore(makeLedgerDbProvider(ledgerDbFile));
    store.ensureAutomationConversation(
      "demo/nightly",
      "demo",
      "Nightly",
      "codex"
    );
    store.close();
    const dispatch = await startLiveDispatch({
      workdir,
      runId: "run-fallback",
      automationRef: "demo/nightly",
      ledgerDbFile,
      runTurn,
      harness: "codex",
      providerEgressConsent: allowProviderEgress,
      model: "gpt-primary",
      configPins: { thought_level: "xhigh" },
      harnessPrefsFor: async (kind) =>
        kind === "claude-code"
          ? { kind, configPins: { thought_level: "high" } }
          : { kind: "codex" },
      onLog: () => undefined,
    });
    openDispatches.push(dispatch);
    await expect(
      dispatch.delegateDispatcher({ prompt: "go" }, dispatchCtx)
    ).rejects.toThrow(/centraid-delegate-failure:.*"failureClass":"quota"/u);
    expect(primary.calls[0]!.input).toMatchObject({
      model: "gpt-primary",
      configPins: { thought_level: "xhigh" },
    });
    expect(fallback.calls).toHaveLength(0);
  });

  test("two named delegates in one fire keep independent sessions, pins, and watermarks", async () => {
    const workdir = await tempDir("centraid-automation-two-harnesses-");
    const ledgerDbFile = ledgerDbFileIn(workdir);
    const ref = "demo/nightly";
    const seed = new ConversationStore(makeLedgerDbProvider(ledgerDbFile));
    seed.ensureAutomationConversation(ref, "demo", "Nightly", "codex");
    for (const [index, kind, sessionId] of [
      [0, "codex", "codex-before"],
      [1, "claude-code", "claude-before"],
    ] as const) {
      const turnId = `seed-${index}`;
      seed.insertTurn({
        turnId,
        conversationId: ref,
        triggerKind: "scheduled",
        startedAt: index * 2 + 1,
      });
      seed.finishTurn({
        turnId,
        endedAt: index * 2 + 2,
        ok: true,
        summary: `seed ${kind}`,
      });
      seed.noteTurn(ref, "", { kind, sessionId });
    }
    seed.close();

    const calls: Array<{ input: TurnInput; config: TurnConfig }> = [];
    const injectedRunTurn: RunTurnFn = async (input, config) => {
      calls.push({ input, config });
      input.onEvent({ type: "final", text: `${config.prefs.kind} answer` });
      return {
        harnessKind: config.prefs.kind,
        sessionId: `${config.prefs.kind}-after`,
        usageSnapshot: { inputTokens: calls.length * 10 },
        hydrated: true,
      };
    };
    const dispatch = await startLiveDispatch({
      workdir,
      runId: "dual-turn",
      automationRef: ref,
      ledgerDbFile,
      runTurn: injectedRunTurn,
      harness: "codex",
      providerEgressConsent: allowProviderEgress,
      model: "default-model",
      configPins: { owner: "default" },
      harnessPrefsFor: async (kind) => ({
        kind,
        configPins: { fromPrefs: kind },
      }),
      onLog: () => undefined,
    });
    openDispatches.push(dispatch);
    const during = new ConversationStore(makeLedgerDbProvider(ledgerDbFile));
    during.insertTurn({
      turnId: "dual-turn",
      conversationId: ref,
      triggerKind: "scheduled",
      startedAt: 10,
    });

    await dispatch.delegateDispatcher(
      {
        prompt: "ask codex",
        harness: "codex",
        model: "codex-model",
        configPins: { perCall: "codex" },
      },
      dispatchCtx
    );
    await dispatch.delegateDispatcher(
      {
        prompt: "ask claude",
        harness: "claude-code",
        model: "claude-model",
        configPins: { perCall: "claude" },
      },
      dispatchCtx
    );
    during.finishTurn({
      turnId: "dual-turn",
      endedAt: 11,
      ok: true,
      summary: "both answered",
    });
    dispatch.finalizeTurn(during, ref, "dual-turn", true);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.input).toMatchObject({
      prevSessionId: "codex-before",
      model: "codex-model",
      configPins: {
        fromPrefs: "codex",
        owner: "default",
        perCall: "codex",
      },
    });
    expect(calls[1]?.input).toMatchObject({
      prevSessionId: "claude-before",
      model: "claude-model",
      configPins: {
        fromPrefs: "claude-code",
        perCall: "claude",
      },
    });
    expect(calls[1]?.input.configPins).not.toHaveProperty("owner");
    const turnSeq = during.getTurn("dual-turn")?.seq;
    expect(turnSeq).toBeTypeOf("number");
    expect(during.getHarnessBinding(ref, "codex")).toMatchObject({
      acpSessionId: "codex-after",
      hydratedThroughSeq: turnSeq,
    });
    expect(during.getHarnessBinding(ref, "claude-code")).toMatchObject({
      acpSessionId: "claude-code-after",
      hydratedThroughSeq: turnSeq,
    });
    during.close();
  });

  test("an unknown named harness fails with typed no-failover metadata", async () => {
    const { delegateDispatcher } = await openDispatch("codex");
    const caughtError = await delegateDispatcher(
      { prompt: "go", harness: "not-installed" },
      dispatchCtx
    ).catch((error: unknown) => error);
    expect(caughtError).toBeInstanceOf(Error);
    expect(
      parseAutomationDelegateFailure((caughtError as Error).message)
    ).toStrictEqual({
      harness: "not-installed",
      failureClass: "unknown",
      message: 'Unknown harness "not-installed" requested by ctx.delegate.',
      explicitHarness: true,
    });
  });

  test.each(["codex", "claude-code"] as const)(
    "ctx.delegate on %s routes through the registry like every other kind",
    async (kind) => {
      const stub = stubBackendRunTurn(kind, (input) => {
        input.onEvent({ type: "final", text: "answer" });
      });

      const { delegateDispatcher } = await openDispatch(kind, "some-model");
      await expect(
        delegateDispatcher({ prompt: "go" }, dispatchCtx)
      ).resolves.toBe("answer");
      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0]?.config.prefs.kind).toBe(kind);
    }
  );

  test("scheduled A→B→A reuses A and hydrates only B ledger turns", async () => {
    const workdir = await tempDir("centraid-automation-bindings-");
    const ledgerDbFile = ledgerDbFileIn(workdir);
    const ref = "demo/nightly";
    const seed = new ConversationStore(makeLedgerDbProvider(ledgerDbFile));
    seed.ensureAutomationConversation(ref, "demo", "Nightly", "codex");
    seed.insertTurn({
      turnId: "a-first",
      conversationId: ref,
      triggerKind: "scheduled",
      startedAt: 1,
    });
    seed.finishTurn({
      turnId: "a-first",
      endedAt: 2,
      ok: true,
      summary: "A first answer",
    });
    seed.noteTurn(ref, "", { kind: "codex", sessionId: "session-a" });
    seed.close();

    const claude = stubBackendRunTurn("claude-code", (input) => {
      input.onEvent({ type: "final", text: "B answer" });
      return {
        harnessKind: "claude-code",
        sessionId: "session-b",
        hydrated: true,
      };
    });
    const bDispatch = await startLiveDispatch({
      workdir,
      runId: "b-turn",
      automationRef: ref,
      ledgerDbFile,
      runTurn,
      harness: "claude-code",
      providerEgressConsent: allowProviderEgress,
      onLog: () => undefined,
    });
    const duringB = new ConversationStore(makeLedgerDbProvider(ledgerDbFile));
    duringB.insertTurn({
      turnId: "b-turn",
      conversationId: ref,
      triggerKind: "scheduled",
      startedAt: 3,
    });
    await bDispatch.delegateDispatcher({ prompt: "run B" }, dispatchCtx);
    duringB.finishTurn({
      turnId: "b-turn",
      endedAt: 4,
      ok: true,
      summary: "B durable answer",
    });
    bDispatch.finalizeTurn(duringB, ref, "b-turn", true);
    duringB.close();
    await bDispatch.close();
    expect(claude.calls[0]?.input.prevSessionId).toBeUndefined();
    expect(claude.calls[0]?.input.hydrationContext).toContain("A first answer");

    const codex = stubBackendRunTurn("codex", (input) => {
      input.onEvent({ type: "final", text: "A returns" });
      return { harnessKind: "codex", sessionId: "session-a" };
    });
    const aDispatch = await startLiveDispatch({
      workdir,
      runId: "a-return",
      automationRef: ref,
      ledgerDbFile,
      runTurn,
      harness: "codex",
      providerEgressConsent: allowProviderEgress,
      onLog: () => undefined,
    });
    const duringA = new ConversationStore(makeLedgerDbProvider(ledgerDbFile));
    duringA.insertTurn({
      turnId: "a-return",
      conversationId: ref,
      triggerKind: "scheduled",
      startedAt: 5,
    });
    await aDispatch.delegateDispatcher({ prompt: "return to A" }, dispatchCtx);
    duringA.finishTurn({ turnId: "a-return", endedAt: 6, ok: true });
    aDispatch.finalizeTurn(duringA, ref, "a-return", true);
    duringA.close();
    await aDispatch.close();

    expect(codex.calls[0]?.input.prevSessionId).toBe("session-a");
    expect(codex.calls[0]?.input.hydrationContext).toContain(
      "B durable answer"
    );
    expect(codex.calls[0]?.input.hydrationContext).not.toContain(
      "A first answer"
    );
    const finalStore = new ConversationStore(
      makeLedgerDbProvider(ledgerDbFile)
    );
    expect(finalStore.getConversation(ref)?.id).toBe(ref);
    expect(finalStore.getTurn("b-turn")?.hydrationTokens).toBeGreaterThan(0);
    expect(finalStore.getHarnessBinding(ref, "codex")?.acpSessionId).toBe(
      "session-a"
    );
    expect(finalStore.getHarnessBinding(ref, "claude-code")?.acpSessionId).toBe(
      "session-b"
    );
    finalStore.close();
  });
});
