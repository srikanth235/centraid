import { describe, expect, it, vi } from "vitest";

import {
  automationLiveMessages,
  createAutomationLiveTrace,
  reduceAutomationTurnEvent,
} from "./automationLiveMessages.js";
import { automationTurnMessages, buildRunSnapshot } from "./runViewData.js";

// `vi.mock` is hoisted above the import by vitest, so the gateway stub lands
// before runViewData.js pulls gateway-client-core's load-time side-effect.
vi.mock(import("../../../gateway-client.js"), () => ({}));

const row = (): CentraidAutomationRow =>
  ({
    id: "digest",
    ref: "digest/main",
    name: "Daily Digest",
    enabled: true,
    triggers: [{ kind: "cron", expr: "0 9 * * *" }],
    manifest: {
      requires: { model: "claude-opus-4-8" },
      prompt: "Summarize",
      history: {},
    },
  }) as unknown as CentraidAutomationRow;

const run = (
  over: Partial<CentraidAutomationTurnRecord> = {}
): CentraidAutomationTurnRecord =>
  ({
    runId: "r1",
    automationId: "digest/main",
    kind: "automation",
    triggerKind: "scheduled",
    startedAt: Date.now() - 5000,
    ok: true,
    ...over,
  }) as unknown as CentraidAutomationTurnRecord;

describe(buildRunSnapshot, () => {
  it("marks an in-flight run running with a pending final", () => {
    const snap = buildRunSnapshot(
      row(),
      run({ endedAt: undefined }),
      [],
      new Map()
    );
    expect(snap.inFlight).toBe(true);
    expect(snap.statusKind).toBe("running");
    expect(snap.final.kind).toBe("pending");
  });

  it("marks a completed run success with an ok final", () => {
    const snap = buildRunSnapshot(
      row(),
      run({ endedAt: Date.now(), ok: true, summary: "done" }),
      [],
      new Map()
    );
    expect(snap.inFlight).toBe(false);
    expect(snap.statusKind).toBe("success");
    expect(snap.final.kind).toBe("ok");
  });

  it("renders a trigger log row plus one per node", () => {
    const nodes = [
      {
        runId: "r1",
        ordinal: 1,
        kind: "tool",
        name: "fetch",
        startedAt: Date.now(),
        ok: true,
      },
    ] as unknown as CentraidAutomationItem[];
    const snap = buildRunSnapshot(
      row(),
      run({ endedAt: Date.now() }),
      nodes,
      new Map()
    );
    // trigger + node + completion row
    expect(snap.logRows).toHaveLength(3);
    expect(snap.logRows[1]?.label).toBe("fetch");
    expect(snap.logRows[1]?.sub).toBe("tool");
  });

  it("labels a data-originated run honestly instead of falling back to cron", () => {
    const snap = buildRunSnapshot(
      row(),
      run({ triggerOrigin: "data" }),
      [],
      new Map()
    );
    expect(snap.logKpi.triggerLabel).toBe("Data");
    expect(snap.logKpi.triggerIcon).toBe("Clock");
    expect(snap.logRows[0]?.label).toBe("Run started by data trigger");
  });

  it("labels a condition-originated run honestly instead of falling back to cron", () => {
    const snap = buildRunSnapshot(
      row(),
      run({ triggerOrigin: "condition" }),
      [],
      new Map()
    );
    expect(snap.logKpi.triggerLabel).toBe("Condition");
    expect(snap.logKpi.triggerIcon).toBe("Clock");
    expect(snap.logRows[0]?.label).toBe("Run started by condition trigger");
  });

  it("degrades gracefully to a raw-ref identity when the parent automation was deleted", () => {
    const snap = buildRunSnapshot(
      null,
      run({ endedAt: Date.now(), ok: true, automationId: "digest/main" }),
      [],
      new Map()
    );
    expect(snap.deleted).toBe(true);
    expect(snap.crumbName).toBe("digest/main");
    expect(snap.headerName).toBe("digest/main");
    expect(snap.promptInstr).toContain("deleted");
    expect(snap.triggersSummary).toBe("Trigger configuration unavailable");
  });

  it("falls back to the run id when a deleted run has no recorded automationId", () => {
    const snap = buildRunSnapshot(
      null,
      run({
        endedAt: Date.now(),
        ok: true,
        automationId: undefined,
        turnId: "r9",
      }),
      [],
      new Map()
    );
    expect(snap.crumbName).toBe("r9");
  });

  it("prefers the run-recorded automation name over the raw ref when the parent was deleted", () => {
    const snap = buildRunSnapshot(
      null,
      run({
        endedAt: Date.now(),
        ok: true,
        automationId: "digest/main",
        automationName: "Daily Digest",
      } as never),
      [],
      new Map()
    );
    expect(snap.deleted).toBe(true);
    expect(snap.crumbName).toBe("Daily Digest");
    expect(snap.headerName).toBe("Daily Digest");
  });

  it("marks a live snapshot as not deleted when the row is present", () => {
    const snap = buildRunSnapshot(row(), run(), [], new Map());
    expect(snap.deleted).toBe(false);
  });

  it("shows a readable model label, stripping the provider prefix", () => {
    const pinned = {
      ...row(),
      manifest: {
        requires: { model: "anthropic/claude-sonnet-5" },
        prompt: "Summarize",
        history: {},
      },
    } as unknown as CentraidAutomationRow;
    const snap = buildRunSnapshot(
      pinned,
      run({ endedAt: Date.now() }),
      [],
      new Map()
    );
    expect(snap.model).toBe("claude-sonnet-5");
    expect(snap.side.model).toBe("claude-sonnet-5");
    expect(snap.final.model).toBe("claude-sonnet-5");
  });

  it("labels the model 'Auto' (never 'Centraid') when the automation pins none", () => {
    const unpinned = {
      ...row(),
      manifest: { requires: {}, prompt: "Summarize", history: {} },
    } as unknown as CentraidAutomationRow;
    const snap = buildRunSnapshot(
      unpinned,
      run({ endedAt: Date.now() }),
      [],
      new Map()
    );
    expect(snap.model).toBe("Auto");
    expect(snap.side.model).toBe("Auto");
  });

  it("labels a deleted run's model 'Auto' rather than the brand name", () => {
    const snap = buildRunSnapshot(
      null,
      run({ endedAt: Date.now() }),
      [],
      new Map()
    );
    expect(snap.side.model).toBe("Auto");
  });

  it("flags hasUsage false for a deterministic zero-usage run", () => {
    const snap = buildRunSnapshot(
      row(),
      run({ endedAt: Date.now() }),
      [],
      new Map()
    );
    expect(snap.side.hasUsage).toBe(false);
  });

  it("flags hasUsage true when the run reports tokens", () => {
    const snap = buildRunSnapshot(
      row(),
      run({
        endedAt: Date.now(),
        totalInputTokens: 100,
        totalOutputTokens: 20,
      } as never),
      [],
      new Map()
    );
    expect(snap.side.hasUsage).toBe(true);
  });

  it("flags hasUsage true when the run has recorded steps", () => {
    const nodes = [
      {
        runId: "r1",
        ordinal: 1,
        kind: "tool",
        name: "fetch",
        startedAt: Date.now(),
        ok: true,
      },
    ] as unknown as CentraidAutomationItem[];
    const snap = buildRunSnapshot(
      row(),
      run({ endedAt: Date.now() }),
      nodes,
      new Map()
    );
    expect(snap.side.hasUsage).toBe(true);
  });

  it("surfaces streamed live text on an in-flight agent node", () => {
    const nodes = [
      {
        runId: "r1",
        ordinal: 2,
        kind: "agent",
        startedAt: Date.now(),
        ok: true,
      },
    ] as unknown as CentraidAutomationItem[];
    const snap = buildRunSnapshot(
      row(),
      run({ endedAt: undefined }),
      nodes,
      new Map([[2, "partial…"]])
    );
    // The live agent text reaches the reader through the projected transcript
    // and the log rows — the dead `nodes` payload is gone (#541).
    expect(snap.logRows[1]?.response).toBe("partial…");
    expect(snap.messages).toContainEqual(
      expect.objectContaining({ kind: "ai", streaming: true, text: "partial…" })
    );
  });
});

describe(automationTurnMessages, () => {
  it("coalesces updates by callId while keeping parallel same-named calls distinct", () => {
    const messages = automationTurnMessages(
      run({ turnId: "turn-1", endedAt: Date.now() }),
      [
        {
          itemId: "start-a",
          turnId: "turn-1",
          ordinal: 1,
          callId: "call-a",
          kind: "tool",
          name: "read_file",
          ok: true,
          startedAt: 1,
        },
        {
          itemId: "finish-a",
          turnId: "turn-1",
          ordinal: 1,
          callId: "call-a",
          kind: "tool",
          name: "read_file",
          ok: false,
          error: "denied",
          startedAt: 1,
          endedAt: 2,
          durationMs: 1,
        },
        {
          itemId: "finish-b",
          turnId: "turn-1",
          ordinal: 2,
          callId: "call-b",
          kind: "tool",
          name: "read_file",
          ok: true,
          startedAt: 1,
          endedAt: 3,
          durationMs: 2,
        },
      ],
      new Map()
    );
    const tools = messages.find((message) => message.kind === "tools");
    expect(tools?.kind === "tools" ? tools.calls : []).toStrictEqual([
      { tool: "read_file", state: "error", meta: "denied" },
      { tool: "read_file", state: "ok", meta: "2ms" },
    ]);
  });

  it("renders failed agent items as shared error messages", () => {
    const messages = automationTurnMessages(
      run({ turnId: "turn-1", endedAt: 3, ok: false }),
      [
        {
          itemId: "agent-1",
          turnId: "turn-1",
          ordinal: 1,
          kind: "agent",
          ok: false,
          error: "runner disconnected",
          startedAt: 1,
          endedAt: 2,
          durationMs: 1,
        },
      ],
      new Map()
    );
    const answer = messages.find((message) => message.kind === "ai");
    expect(answer?.kind === "ai" && !answer.streaming && answer.error).toBe(
      true
    );
    expect(answer?.kind === "ai" && !answer.streaming && answer.copyText).toBe(
      "runner disconnected"
    );
  });
});

describe("automation live trace reducer", () => {
  it("projects standard assistant, reasoning, tool, notice, usage and final events", () => {
    let state = createAutomationLiveTrace("what changed?");
    state = reduceAutomationTurnEvent(state, {
      type: "reasoning.delta",
      delta: "checking",
    });
    state = reduceAutomationTurnEvent(state, {
      type: "tool.start",
      toolCallId: "call-1",
      toolName: "gmail.search",
    });
    state = reduceAutomationTurnEvent(state, {
      type: "assistant.delta",
      delta: "Three messages",
    });
    state = reduceAutomationTurnEvent(state, {
      type: "tool.result",
      toolCallId: "call-1",
      toolName: "gmail.search",
      ok: true,
    });
    state = reduceAutomationTurnEvent(state, {
      type: "notice",
      level: "info",
      message: "Used the bound work account.",
    });
    state = reduceAutomationTurnEvent(state, {
      type: "usage",
      model: "fast-model",
      inputTokens: 20,
      outputTokens: 5,
      costUsd: 0.001,
      costSource: "agent",
    });
    state = reduceAutomationTurnEvent(state, {
      type: "final",
      text: "Three messages arrived.",
      stopReason: "end_turn",
    });
    const messages = automationLiveMessages(state);
    expect(messages.map((message) => message.kind)).toStrictEqual([
      "user",
      "thinking",
      "tools",
      "notice",
      "ai",
    ]);
    expect(messages[2]).toMatchObject({
      kind: "tools",
      calls: [{ tool: "gmail.search", state: "ok" }],
    });
    expect(messages.at(-1)).toMatchObject({
      kind: "ai",
      streaming: false,
      error: false,
      copyText: "Three messages arrived.",
      usage: {
        inputTokens: 20,
        outputTokens: 5,
        costUsd: 0.001,
        model: "fast-model",
      },
    });
  });

  it("keeps parallel same-named live tools distinct by call id", () => {
    let state = createAutomationLiveTrace();
    for (const toolCallId of ["a", "b"]) {
      state = reduceAutomationTurnEvent(state, {
        type: "tool.start",
        toolCallId,
        toolName: "read_file",
      });
    }
    state = reduceAutomationTurnEvent(state, {
      type: "tool.result",
      toolCallId: "b",
      toolName: "read_file",
      ok: false,
      errorText: "denied",
    });
    const tools = automationLiveMessages(state).find(
      (message) => message.kind === "tools"
    );
    expect(tools?.kind === "tools" ? tools.calls : []).toStrictEqual([
      { tool: "read_file", state: "run", meta: "running…" },
      { tool: "read_file", state: "error", meta: "denied" },
    ]);
  });
});
