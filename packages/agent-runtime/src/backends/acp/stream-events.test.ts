// Coverage for the session/update → TurnStreamEvent mapper. Drives the pure
// factory directly with hand-built ACP notifications so every update variant,
// guard, and accumulation branch is exercised without a live agent.

import { describe, expect, test } from "vitest";

import type { TurnStreamEvent } from "@centraid/app-engine";

import { createSessionUpdateMapper } from "./stream-events.ts";

function harness() {
  const events: TurnStreamEvent[] = [];
  const mapper = createSessionUpdateMapper((e) => events.push(e));
  const types = (): string[] => events.map((e) => e.type);
  return { events, mapper, types };
}
describe("stream-events suite", () => {
  test("ignores updates with missing / malformed params", () => {
    const { mapper, events } = harness();
    mapper.handleSessionUpdate(undefined);
    mapper.handleSessionUpdate({});
    mapper.handleSessionUpdate({ update: null });
    mapper.handleSessionUpdate({ update: "not-an-object" });
    expect(events).toStrictEqual([]);
  });

  test("agent_message_chunk emits assistant.start once then deltas, accumulating finalText", () => {
    const { mapper, events, types } = harness();
    // An empty chunk emits nothing (no start, no delta).
    mapper.handleSessionUpdate({
      update: { sessionUpdate: "agent_message_chunk", content: "" },
    });
    expect(events).toStrictEqual([]);

    mapper.handleSessionUpdate({
      update: { sessionUpdate: "agent_message_chunk", content: "Hello " },
    });
    mapper.handleSessionUpdate({
      update: {
        sessionUpdate: "agent_message_chunk",
        content: [{ text: "world" }],
      },
    });
    expect(types()).toStrictEqual([
      "assistant.start",
      "assistant.delta",
      "assistant.delta",
    ]);
    expect(mapper.finalText()).toBe("Hello world");
  });

  test("agent_thought_chunk emits reasoning deltas and skips empty ones", () => {
    const { mapper, events, types } = harness();
    mapper.handleSessionUpdate({
      update: { sessionUpdate: "agent_thought_chunk", content: "" },
    });
    expect(events).toStrictEqual([]);
    mapper.handleSessionUpdate({
      update: { sessionUpdate: "agent_thought_chunk", content: "thinking" },
    });
    expect(types()).toStrictEqual(["assistant.start", "reasoning.delta"]);
  });

  test("tool_call without an id is dropped", () => {
    const { mapper, events } = harness();
    mapper.handleSessionUpdate({ update: { sessionUpdate: "tool_call" } });
    expect(events).toStrictEqual([]);
  });

  test("tool_call emits tool.start with title fallback and passes rawInput through", () => {
    const { mapper, events } = harness();
    mapper.handleSessionUpdate({
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "read_file",
        rawInput: { path: "a.txt" },
      },
    });
    const start = events.find((e) => e.type === "tool.start");
    expect(start && start.type === "tool.start" && start.toolName).toBe(
      "read_file"
    );
    expect(start && start.type === "tool.start" && start.args).toStrictEqual({
      path: "a.txt",
    });
    expect(
      start && start.type === "tool.start" && JSON.parse(start.rawJson ?? "{}")
    ).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
    });
  });

  test('tool_call falls back to kind, then "tool", for its title', () => {
    const { mapper, events } = harness();
    mapper.handleSessionUpdate({
      update: { sessionUpdate: "tool_call", toolCallId: "a", kind: "edit" },
    });
    mapper.handleSessionUpdate({
      update: { sessionUpdate: "tool_call", toolCallId: "b" },
    });
    const starts = events.filter((e) => e.type === "tool.start");
    expect(
      starts.map((e) => e.type === "tool.start" && e.toolName)
    ).toStrictEqual(["edit", "tool"]);
  });

  test("a tool_call that arrives already completed emits both start and result", () => {
    const { mapper, events } = harness();
    mapper.handleSessionUpdate({
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "done",
        title: "grep",
        status: "completed",
        rawOutput: { hits: 2 },
      },
    });
    const result = events.find((e) => e.type === "tool.result");
    expect(result && result.type === "tool.result" && result.ok).toBe(true);
    expect(
      result && result.type === "tool.result" && result.result
    ).toStrictEqual({ hits: 2 });
    expect(
      result &&
        result.type === "tool.result" &&
        JSON.parse(result.rawJson ?? "{}")
    ).toMatchObject({ toolCallId: "done", status: "completed" });
  });

  test("an agent’s own rawOutput.content survives the renderable-content merge", () => {
    // The merge used to spread rawOutput and then overwrite `content` with our
    // renderable projection, silently destroying the payload the agent chose to
    // return under that key.
    const { mapper, events } = harness();
    mapper.handleSessionUpdate({
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "merge",
        title: "search",
        status: "completed",
        rawOutput: { content: [{ path: "a.txt", score: 0.9 }], hits: 1 },
        content: [
          { type: "content", content: { type: "text", text: "found 1 match" } },
        ],
      },
    });
    const result = events.find(
      (event): event is Extract<TurnStreamEvent, { type: "tool.result" }> =>
        event.type === "tool.result"
    );
    const merged = result?.result as Record<string, unknown>;
    expect(merged.hits).toBe(1);
    // The renderable projection is what the UI reads…
    expect(merged.content).toStrictEqual([
      { type: "text", text: "found 1 match" },
    ]);
    // …and the agent's own payload is still there, not overwritten.
    expect(merged.rawOutputContent).toStrictEqual([
      { path: "a.txt", score: 0.9 },
    ]);
  });

  test("tool_call_update maps failed → ok:false with an error message, and dedupes", () => {
    const { mapper, events } = harness();
    mapper.handleSessionUpdate({
      update: { sessionUpdate: "tool_call", toolCallId: "x", title: "run" },
    });
    mapper.handleSessionUpdate({
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "x",
        status: "failed",
        content: "boom",
      },
    });
    // A second terminal update for the same id must not emit twice.
    mapper.handleSessionUpdate({
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "x",
        status: "completed",
      },
    });
    const results = events.filter((e) => e.type === "tool.result");
    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r && r.type === "tool.result" && r.ok).toBe(false);
    expect(r && r.type === "tool.result" && r.errorText).toBe("boom");
  });

  test("a failed tool result with no content still carries a default error message", () => {
    const { mapper, events } = harness();
    mapper.handleSessionUpdate({
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "y",
        status: "failed",
      },
    });
    const r = events.find((e) => e.type === "tool.result");
    expect(r && r.type === "tool.result" && r.errorText).toBe(
      "tool call failed"
    );
  });

  test("tool_call_update without an id, or with a non-terminal status, emits nothing", () => {
    const { mapper, events } = harness();
    mapper.handleSessionUpdate({
      update: { sessionUpdate: "tool_call_update" },
    });
    mapper.handleSessionUpdate({
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "p",
        status: "in_progress",
      },
    });
    expect(events).toStrictEqual([]);
  });

  test("plan emits a phase event, with detail only when entries are present", () => {
    const { mapper, events } = harness();
    mapper.handleSessionUpdate({
      update: {
        sessionUpdate: "plan",
        entries: [{ content: "step 1", status: "pending" }],
      },
    });
    mapper.handleSessionUpdate({ update: { sessionUpdate: "plan" } });
    const phases = events.filter((e) => e.type === "phase");
    expect(phases).toHaveLength(2);
    const [withEntries, without] = phases;
    expect(
      withEntries && withEntries.type === "phase" && withEntries.detail
    ).toStrictEqual([{ content: "step 1", status: "pending" }]);
    expect(
      withEntries && withEntries.type === "phase" && withEntries.plan
    ).toStrictEqual([{ content: "step 1", status: "pending" }]);
    expect(without && without.type === "phase" && "detail" in without).toBe(
      false
    );
  });

  test("tool result extracts diff content blocks", () => {
    const { mapper, events } = harness();
    mapper.handleSessionUpdate({
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "d1",
        title: "edit",
        kind: "edit",
        status: "completed",
        content: [{ type: "diff", path: "a.ts", oldText: "x", newText: "y" }],
      },
    });
    const result = events.find((e) => e.type === "tool.result");
    expect(
      result && result.type === "tool.result" && result.diffs
    ).toStrictEqual([{ path: "a.ts", oldText: "x", newText: "y" }]);
    expect(events.some((e) => e.type === "phase" && e.phase === "diff")).toBe(
      true
    );
  });

  test("tool result preserves renderable content and terminal output as CAS candidates", () => {
    const { mapper, events } = harness();
    mapper.handleSessionUpdate({
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "terminal-1",
        title: "shell",
        status: "completed",
        rawOutput: { exitCode: 0 },
        locations: [{ path: "/workspace/report.txt", line: 7 }],
        content: [
          { type: "content", content: "human-readable result" },
          { type: "terminal", terminalId: "term-1", output: "build passed" },
        ],
      },
    });
    const result = events.find(
      (event): event is Extract<TurnStreamEvent, { type: "tool.result" }> =>
        event.type === "tool.result"
    );
    expect(result?.locations).toStrictEqual([
      { path: "/workspace/report.txt", line: 7 },
    ]);
    expect(result?.result).toMatchObject({
      exitCode: 0,
      content: [
        "human-readable result",
        { type: "terminal", terminalId: "term-1", output: "build passed" },
      ],
    });
    expect(
      result?.artifacts?.map((artifact) => ({
        filename: artifact.filename,
        text: Buffer.from(artifact.dataBase64, "base64").toString("utf8"),
      }))
    ).toStrictEqual([
      { filename: "tool-output.txt", text: "human-readable result" },
      { filename: "terminal-output.txt", text: "build passed" },
    ]);
  });

  test("usage_update folds tokens and cost, surfaced via usage()", () => {
    const { mapper } = harness();
    mapper.handleSessionUpdate({
      update: {
        sessionUpdate: "usage_update",
        inputTokens: 100,
        outputTokens: 50,
        cost: { amount: 0.25, currency: "USD" },
      },
    });
    const usage = mapper.usage();
    expect(usage.tokens).toStrictEqual({ inputTokens: 100, outputTokens: 50 });
    expect(usage.cost).toStrictEqual({ amount: 0.25, currency: "USD" });
  });

  test("usage_update with an unreadable cost leaves cost undefined", () => {
    const { mapper } = harness();
    mapper.handleSessionUpdate({
      update: { sessionUpdate: "usage_update", cost: { amount: "nope" } },
    });
    expect(mapper.usage().cost).toBeUndefined();
  });

  test("unknown session update kinds are ignored", () => {
    const { mapper, events } = harness();
    mapper.handleSessionUpdate({
      update: { sessionUpdate: "current_mode_update", modeId: "x" },
    });
    mapper.handleSessionUpdate({
      update: { sessionUpdate: "user_message_chunk", content: "hi" },
    });
    expect(events).toStrictEqual([]);
  });

  test("foldTokenUsage merges a breakdown read elsewhere (last write wins)", () => {
    const { mapper } = harness();
    mapper.handleSessionUpdate({
      update: { sessionUpdate: "usage_update", inputTokens: 10 },
    });
    mapper.foldTokenUsage({ outputTokens: 5, inputTokens: 99 });
    expect(mapper.usage().tokens).toStrictEqual({
      inputTokens: 99,
      outputTokens: 5,
    });
  });

  test("agentStreamsTool matches an open tool by name substring and ignores done / empty", () => {
    const { mapper } = harness();
    expect(mapper.agentStreamsTool("")).toBe(false);
    mapper.handleSessionUpdate({
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "m",
        title: "mcp__centraid__vault_sql",
      },
    });
    expect(mapper.agentStreamsTool("vault_sql")).toBe(true);
    expect(mapper.agentStreamsTool("other_tool")).toBe(false);
    // Once the call closes it no longer counts as "streaming".
    mapper.handleSessionUpdate({
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "m",
        status: "completed",
      },
    });
    expect(mapper.agentStreamsTool("vault_sql")).toBe(false);
  });
});
