// governance: allow-repo-hygiene file-size-limit (#567) one fire-spine suite shares the real worker, stable automation conversation, audit store, failover notice, and onFailure fixtures
import { promises as fs } from "node:fs";
/*
 * Automation fire spine (issue #147, Concern 2). The per-fire orchestration
 * lives here in app-engine; the `ctx.agent` dispatch surface is injected by
 * the host via `openDispatch`. These tests run a real (trivial) `handler.js`
 * through `runFire` with a STUB dispatch surface, proving the spine resolves
 * the automation, opens its ledger, runs the handler, and cascades
 * `onFailure` — all without any agent-runtime CLI machinery.
 */
import path from "node:path";

import {
  ConversationHistoryStore,
  ConversationStore,
  makeJournalDbProvider,
  setPricingCatalog,
} from "@centraid/app-engine";
import type { AutomationTurnStreamEvent } from "@centraid/app-engine";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Manifest } from "../manifest/manifest.js";
import { runFire } from "./fire.js";
import type { DispatchSurface, OpenDispatchArgs } from "./fire.js";

function manifest(over: Partial<Manifest> = {}): Manifest {
  return {
    name: "Digest",
    version: "0.1.0",
    enabled: true,
    prompt: "do the thing",
    triggers: [{ kind: "cron", expr: "0 9 * * *" }],
    requires: {},
    history: { keep: { count: 100 } },
    generated: { by: "test", at: "2026-05-22" },
    ...over,
  };
}

async function writeAutomation(
  appsDir: string,
  appId: string,
  id: string,
  m: Manifest,
  handler = "export default async () => ({ ok: true });"
): Promise<void> {
  const dir = path.join(appsDir, appId, "automations", id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "automation.json"),
    JSON.stringify(m, null, 2)
  );
  await fs.writeFile(path.join(dir, "handler.js"), handler);
}

/** A stub dispatch surface that records that it was opened + closed. The
 *  trivial handlers below never call `ctx.agent`, so the dispatcher itself is
 *  never invoked. */
function stubDispatch(opened: OpenDispatchArgs[], closes: { n: number }) {
  return (args: OpenDispatchArgs): Promise<DispatchSurface> => {
    opened.push(args);
    return Promise.resolve({
      agentDispatcher: async () => "",
      async close() {
        closes.n += 1;
      },
    });
  };
}

describe(runFire, () => {
  let appsDir: string;
  let journalDbFile: string;

  beforeEach(async () => {
    appsDir = await tempDir("centraid-fire-");
    journalDbFile = path.join(appsDir, "journal.db");
  });
  afterEach(async () => {
    await fs.rm(appsDir, { recursive: true, force: true });
  });

  it("resolves the automation, opens an injected dispatch surface, and closes it", async () => {
    await writeAutomation(appsDir, "notes", "digest", manifest());
    const opened: OpenDispatchArgs[] = [];
    const closes = { n: 0 };

    const { outcome, record } = await runFire(
      { automationRef: "notes/digest", appsDir, journalDbFile },
      { openDispatch: stubDispatch(opened, closes) }
    );

    expect(outcome.ok).toBe(true);
    expect(record.automationRef).toBe("notes/digest");
    expect(record.automationName).toBe("Digest");

    // The spine opened exactly one dispatch surface, with the resolved app
    // dir as workdir.
    expect(opened).toHaveLength(1);
    expect(opened[0]!.automationRef).toBe("notes/digest");
    expect(opened[0]!.workdir).toMatch(/notes[/\\]automations[/\\]digest$/u);
    expect(closes.n).toBe(1);
  });

  it("persists a failover boundary as a transcript notice that survives reload", async () => {
    await writeAutomation(appsDir, "notes", "digest", manifest());
    const notice =
      "codex failed at the automation fire boundary (quota). Continuing with copilot.";
    const { record } = await runFire(
      {
        automationRef: "notes/digest",
        appsDir,
        journalDbFile,
        runId: "failover-attempt",
        runnerKind: "copilot",
        note: notice,
        failoverNotice: notice,
      },
      { openDispatch: stubDispatch([], { n: 0 }) }
    );

    const journal = makeJournalDbProvider(journalDbFile);
    const store = new ConversationStore(journal);
    expect(store.listItems(record.runId)).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "step",
          name: "notice:warn:failover",
          outputJson: JSON.stringify({ text: notice }),
        }),
      ])
    );
    store.close();

    const history = new ConversationHistoryStore(() => ({
      vaultId: "vault-test",
      ownerPartyId: "",
      appsDir,
      journal,
      journalDbFile,
      runnerSessionDir: path.join(appsDir, "runner-sessions"),
    }));
    expect(history.getSession("notes", "notes/digest")?.messages).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            kind: "notice",
            level: "warn",
            text: notice,
          }),
        }),
      ])
    );
  });

  it("injects one fire-start instant as deterministic ctx.now", async () => {
    await writeAutomation(
      appsDir,
      "notes",
      "clock",
      manifest(),
      "export default async ({ ctx }) => ({ output: { now: ctx.now } });"
    );
    const opened: OpenDispatchArgs[] = [];
    const closes = { n: 0 };
    const { outcome, record } = await runFire(
      { automationRef: "notes/clock", appsDir, journalDbFile },
      { openDispatch: stubDispatch(opened, closes) }
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.output).toStrictEqual({
      now: new Date(record.startedAt).toISOString(),
    });
  });

  it("emits a live turn stream: turn.start → item lifecycle per ctx call → turn.end", async () => {
    // A handler that drives one ctx.agent. The stub dispatch returns a fixed
    // answer so the node lifecycle is deterministic.
    await writeAutomation(
      appsDir,
      "notes",
      "flow",
      manifest({ name: "Flow" }),
      `export default async ({ ctx }) => {
         await ctx.agent({ prompt: 'summarize' });
         return { ok: true };
       };`
    );
    const events: AutomationTurnStreamEvent[] = [];
    const dispatch = (args: OpenDispatchArgs): Promise<DispatchSurface> => {
      void args;
      return Promise.resolve({
        agentDispatcher: async () => "a summary",
        async close() {},
      });
    };

    const { outcome } = await runFire(
      {
        automationRef: "notes/flow",
        appsDir,
        journalDbFile,
        onRunEvent: (ev) => events.push(ev),
      },
      { openDispatch: dispatch }
    );
    expect(outcome.ok).toBe(true);

    // turn.start first, turn.end last.
    expect(events.at(0)?.type).toBe("turn.start");
    expect(events.at(-1)?.type).toBe("turn.end");
    const end = events.at(-1) as Extract<
      AutomationTurnStreamEvent,
      { type: "turn.end" }
    >;
    expect(end.ok).toBe(true);

    // The agent item opened (start) before it closed (end), at ordinal 0.
    const lifecycle = events.filter(
      (e) => e.type === "item.start" || e.type === "item.end"
    );
    expect(
      lifecycle.map((e) => [
        e.type,
        (e as { ordinal: number }).ordinal,
        (e as { kind?: string }).kind,
      ])
    ).toStrictEqual([
      ["item.start", 0, "agent"],
      ["item.end", 0, undefined],
    ]);
    const agentStart = lifecycle[0] as Extract<
      AutomationTurnStreamEvent,
      { type: "item.start" }
    >;
    expect(agentStart.name).toBe("agent");
    expect(agentStart.args).toStrictEqual({ prompt: "summarize" });
  });

  it("streams ctx.agent token deltas as item.delta and persists the usage rollup", async () => {
    await writeAutomation(
      appsDir,
      "notes",
      "ask",
      manifest({ name: "Ask" }),
      `export default async ({ ctx }) => {
         const answer = await ctx.agent({ prompt: 'hi' });
         return { output: answer };
       };`
    );
    const events: AutomationTurnStreamEvent[] = [];
    // A stub agent dispatcher that behaves like a streaming chat adapter:
    // forward token deltas + a usage event through `call.onEvent`, then
    // return the final answer.
    const dispatch = (): Promise<DispatchSurface> =>
      Promise.resolve({
        agentDispatcher: async (call) => {
          call.onEvent?.({ type: "assistant.delta", delta: "hel" });
          call.onEvent?.({ type: "assistant.delta", delta: "lo" });
          call.onEvent?.({
            type: "usage",
            provider: "prov",
            model: "a-capable-model",
            inputTokens: 12,
            outputTokens: 3,
            costUsd: 0.005,
            costSource: "agent",
          });
          call.onEvent?.({ type: "final", text: "hello" });
          return "hello";
        },
        async close() {},
      });

    const { outcome, record } = await runFire(
      {
        automationRef: "notes/ask",
        appsDir,
        journalDbFile,
        runnerKind: "codex",
        model: "a-capable-model",
        onRunEvent: (ev) => events.push(ev),
      },
      { openDispatch: dispatch }
    );
    expect(outcome.ok).toBe(true);

    // Token deltas surfaced as item.delta on the agent item (ordinal 0).
    const deltas = events.filter((e) => e.type === "item.delta");
    expect(deltas.length >= 3).toBeTruthy();
    expect(
      deltas.every((d) => (d as { ordinal: number }).ordinal === 0)
    ).toBeTruthy();
    const deltaTypes = deltas.map(
      (d) => ((d as { event: { type: string } }).event ?? {}).type
    );
    expect(deltaTypes.includes("assistant.delta")).toBeTruthy();
    expect(deltaTypes.includes("usage")).toBeTruthy();

    // The usage event was persisted onto the agent node's ledger row, so the
    // run's token rollup is accurate.
    const store = new ConversationStore(makeJournalDbProvider(journalDbFile));
    const agentNode = store
      .listItems(record.runId)
      .find((n) => n.kind === "agent");
    expect(agentNode).toBeTruthy();
    expect(agentNode!.model).toBe("a-capable-model");
    expect(agentNode!.inputTokens).toBe(12);
    expect(agentNode!.outputTokens).toBe(3);
    expect(agentNode!.costUsd).toBe(0.005);
    expect(agentNode!.costSource).toBe("agent");
    const run = store.getTurn(record.runId);
    expect(run?.conversationId).toBe("notes/ask");
    expect(run?.totalInputTokens).toBe(12);
    expect(run?.totalOutputTokens).toBe(3);
    store.close();
  });

  it("persists overlapping ACP tool calls as distinct callId-keyed items", async () => {
    await writeAutomation(
      appsDir,
      "notes",
      "parallel",
      manifest({ name: "Parallel" }),
      `export default async ({ ctx }) => {
         return { output: await ctx.agent({ prompt: 'compare both files' }) };
       };`
    );
    const dispatch = (): Promise<DispatchSurface> =>
      Promise.resolve({
        agentDispatcher: async (call) => {
          call.onEvent?.({
            type: "tool.start",
            toolCallId: "call-a",
            toolName: "read_file",
            args: { path: "a.txt" },
            rawJson: '{"toolCallId":"call-a","status":"pending"}',
          });
          call.onEvent?.({
            type: "tool.start",
            toolCallId: "call-b",
            toolName: "read_file",
            args: { path: "b.txt" },
            rawJson: '{"toolCallId":"call-b","status":"pending"}',
          });
          // Finish out of start order: name/ordinal correlation would cross
          // these results; callId correlation must not.
          call.onEvent?.({
            type: "tool.result",
            toolCallId: "call-b",
            toolName: "read_file",
            ok: true,
            result: "B",
            rawJson:
              '{"toolCallId":"call-b","status":"completed","rawOutput":"B"}',
          });
          call.onEvent?.({
            type: "tool.result",
            toolCallId: "call-a",
            toolName: "read_file",
            ok: true,
            result: "A",
            rawJson:
              '{"toolCallId":"call-a","status":"completed","rawOutput":"A"}',
          });
          call.onEvent?.({
            type: "final",
            text: "done",
            stopReason: "end_turn",
            rawJson: '{"stopReason":"end_turn"}',
          });
          return "done";
        },
        async close() {},
      });

    const { record } = await runFire(
      { automationRef: "notes/parallel", appsDir, journalDbFile },
      { openDispatch: dispatch }
    );
    const store = new ConversationStore(makeJournalDbProvider(journalDbFile));
    const tools = store
      .listItems(record.runId)
      .filter((item) => item.kind === "tool")
      .sort((a, b) => (a.callId ?? "").localeCompare(b.callId ?? ""));
    expect(tools.map((item) => [item.callId, item.outputJson])).toStrictEqual([
      ["call-a", '"A"'],
      ["call-b", '"B"'],
    ]);
    expect(
      tools.map((item) => JSON.parse(item.rawJson ?? "{}").toolCallId)
    ).toStrictEqual(["call-a", "call-b"]);
    expect(
      store.listItems(record.runId).find((item) => item.kind === "agent")
        ?.rawJson
    ).toBe('{"stopReason":"end_turn"}');
    store.close();
  });

  it("keeps the final runner envelope when a later error carries none", async () => {
    const handler = `export default async ({ ctx }) => ({ output: await ctx.agent({ prompt: 'go' }) });`;
    await writeAutomation(
      appsDir,
      "notes",
      "late-error",
      manifest({ name: "LateError" }),
      handler
    );
    const dispatch = (): Promise<DispatchSurface> =>
      Promise.resolve({
        agentDispatcher: async (call) => {
          call.onEvent?.({
            type: "final",
            text: "done",
            rawJson: '{"stopReason":"end_turn"}',
          });
          // A trailing error with no envelope of its own must not blank the
          // one the final already captured.
          call.onEvent?.({ type: "error", message: "stream closed late" });
          return "done";
        },
        async close() {},
      });

    const { record } = await runFire(
      { automationRef: "notes/late-error", appsDir, journalDbFile },
      { openDispatch: dispatch }
    );
    const store = new ConversationStore(makeJournalDbProvider(journalDbFile));
    expect(
      store.listItems(record.runId).find((item) => item.kind === "agent")
        ?.rawJson
    ).toBe('{"stopReason":"end_turn"}');
    store.close();
  });

  it("does not attribute an unconfirmed configured model when estimating usage", async () => {
    setPricingCatalog({
      "priced-fixture-model": {
        input_cost_per_token: 0.001,
        output_cost_per_token: 0.002,
      },
    });
    await writeAutomation(
      appsDir,
      "notes",
      "priced",
      manifest({ name: "Priced" }),
      `export default async ({ ctx }) => ({
         output: await ctx.agent({ prompt: 'price this' }),
       });`
    );
    const dispatch = (): Promise<DispatchSurface> =>
      Promise.resolve({
        agentDispatcher: async (call) => {
          call.onEvent?.({ type: "usage", inputTokens: 2, outputTokens: 3 });
          call.onEvent?.({ type: "final", text: "done" });
          return "done";
        },
        async close() {},
      });

    const { record } = await runFire(
      {
        automationRef: "notes/priced",
        appsDir,
        journalDbFile,
        runnerKind: "codex",
        model: "priced-fixture-model",
      },
      { openDispatch: dispatch }
    );
    const store = new ConversationStore(makeJournalDbProvider(journalDbFile));
    const item = store
      .listItems(record.runId)
      .find((entry) => entry.kind === "agent");
    // The harness confirmed neither a model nor a cost, so the run books
    // "unknown" — not the configured model, and not an invented number.
    expect(item?.model).toBeUndefined();
    expect(item?.costUsd).toBeUndefined();
    expect(item?.costSource).toBeUndefined();
    store.close();
  });

  it("books an unpriceable harness report as unknown rather than inventing a rate", async () => {
    setPricingCatalog({
      "catalog-low": {
        input_cost_per_token: 0.001,
        output_cost_per_token: 0.002,
      },
      "catalog-ceiling": {
        input_cost_per_token: 0.003,
        output_cost_per_token: 0.004,
      },
    });
    await writeAutomation(
      appsDir,
      "notes",
      "unmodelled",
      manifest({ name: "Unmodelled" }),
      `export default async ({ ctx }) => ({
         output: await ctx.agent({ prompt: 'price this too' }),
       });`
    );
    const dispatch = (): Promise<DispatchSurface> =>
      Promise.resolve({
        agentDispatcher: async (call) => {
          call.onEvent?.({ type: "usage", inputTokens: 2, outputTokens: 3 });
          call.onEvent?.({ type: "final", text: "done" });
          return "done";
        },
        async close() {},
      });

    const { record } = await runFire(
      {
        automationRef: "notes/unmodelled",
        appsDir,
        journalDbFile,
        runnerKind: "acp",
      },
      { openDispatch: dispatch }
    );
    const store = new ConversationStore(makeJournalDbProvider(journalDbFile));
    const agentItem = store
      .listItems(record.runId)
      .find((item) => item.kind === "agent");
    // Tokens without a priceable model are unknown, and unknown is NULL: a
    // catalog-wide ceiling would be indistinguishable from a real estimate.
    expect(agentItem?.costSource).toBeUndefined();
    expect(agentItem?.costUsd).toBeUndefined();
    expect(agentItem?.model).toBeUndefined();
    store.close();
  });

  it("cascades onFailure through the injected surface with the target automation harness", async () => {
    // `main` throws → its onFailure target `recover` fires, both via the one
    // injected `openDispatch`. Proves the cascade stayed in the spine and did
    // not leak back into the host.
    await writeAutomation(
      appsDir,
      "notes",
      "main",
      manifest({ name: "Main", onFailure: "recover" }),
      'export default async () => { throw new Error("boom"); };'
    );
    await writeAutomation(
      appsDir,
      "notes",
      "recover",
      manifest({ name: "Recover" })
    );

    const opened: OpenDispatchArgs[] = [];
    const closes = { n: 0 };

    const { outcome } = await runFire(
      {
        automationRef: "notes/main",
        appsDir,
        journalDbFile,
        runnerKind: "codex",
        resolveNestedRuntime: async (ref) =>
          ref === "notes/recover"
            ? { runnerKind: "claude-code", model: "recovery-model" }
            : { runnerKind: "codex" },
      },
      { openDispatch: stubDispatch(opened, closes) }
    );

    expect(outcome.ok).toBe(false);
    expect(
      opened.map((entry) => [
        entry.automationRef,
        entry.runnerKind,
        entry.model,
      ])
    ).toStrictEqual([
      ["notes/main", "codex", undefined],
      ["notes/recover", "claude-code", "recovery-model"],
    ]);
    const store = new ConversationStore(makeJournalDbProvider(journalDbFile));
    expect(store.getConversation("notes/main")?.adapterKind).toBe("codex");
    expect(store.getConversation("notes/recover")?.adapterKind).toBe(
      "claude-code"
    );
    store.close();
    expect(closes.n).toBe(2);
  });

  it("settles the turn and keeps a successful outcome when finalization fails", async () => {
    await writeAutomation(
      appsDir,
      "notes",
      "settle",
      manifest({ name: "Settle" }),
      'export default async () => ({ summary: "handler did its work" });'
    );
    const dispatch = (): Promise<DispatchSurface> =>
      Promise.resolve({
        agentDispatcher: async () => "",
        finalizeTurn() {
          throw new Error("harness binding write failed");
        },
        async close() {},
      });

    const { outcome, record } = await runFire(
      {
        automationRef: "notes/settle",
        appsDir,
        journalDbFile,
        runnerKind: "codex",
      },
      { openDispatch: dispatch }
    );

    // The handler succeeded; a host-side binding write did not. The outcome
    // must not be rewritten to failed (that would cascade onFailure).
    expect(outcome.ok).toBe(true);

    const store = new ConversationStore(makeJournalDbProvider(journalDbFile));
    const turn = store.getTurn(record.runId);
    // The failed transaction rolled its own finishTurn back; the turn is still
    // settled durably rather than left running forever.
    expect(turn?.endedAt).toBeTypeOf("number");
    expect(turn?.ok).toBe(true);
    expect(turn?.error).toContain("harness binding write failed");
    const notice = store
      .listItems(record.runId)
      .find((i) => i.name === "notice:error:finalization");
    expect(notice?.ok).toBe(false);
    store.close();
  });
});
