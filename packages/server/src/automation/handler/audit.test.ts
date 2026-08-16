/**
 * Direct unit tests for automation handler audit helpers (issue #545 B5).
 */

import { describe, expect, it, vi } from "vitest";

import type { ConversationStore, Turn } from "@centraid/server/engine";

import type { RunEventSink } from "./audit.js";
import {
  applyRetention,
  extractReturnEnvelope,
  makeNodeId,
  noopRunEventSink,
  rowToRunRef,
  truncateForAudit,
  usageCloseFields,
  openRunNode,
  closeRunNode,
} from "./audit.js";

describe(truncateForAudit, () => {
  it("returns undefined for undefined and serializes small values", () => {
    expect(truncateForAudit(undefined)).toBeUndefined();
    expect(truncateForAudit({ a: 1 })).toBe(JSON.stringify({ a: 1 }));
  });

  it("caps oversize payloads with a truncation envelope", () => {
    const big = { blob: "x".repeat(70_000) };
    const out = JSON.parse(truncateForAudit(big)!) as {
      _truncated: boolean;
      bytes: number;
      head: string;
    };
    expect(out._truncated).toBe(true);
    expect(out.bytes).toBeGreaterThan(64 * 1024);
    expect(out.head).toHaveLength(256);
  });

  it("marks unserializable values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(JSON.parse(truncateForAudit(cyclic)!)).toStrictEqual({
      _truncated: true,
      reason: "unserializable",
    });
  });
});

describe("rowToRunRef / extractReturnEnvelope / makeNodeId", () => {
  it("projects a turn into a RunRef and parses input/output JSON when valid", () => {
    const turn: Turn = {
      turnId: "t1",
      conversationId: "app/digest",
      seq: 0,
      triggerKind: "scheduled",
      startedAt: 10,
      endedAt: 20,
      ok: true,
      summary: "done",
      outputJson: '{"n":1}',
      pinned: false,
    };
    const ref = rowToRunRef(turn, "app/digest", '{"k":2}');
    expect(ref).toMatchObject({
      runId: "t1",
      automationId: "app/digest",
      triggerKind: "scheduled",
      ok: true,
      summary: "done",
      input: { k: 2 },
      output: { n: 1 },
    });
    // Non-JSON input falls through as a string.
    expect(rowToRunRef(turn, "app/digest", "not-json").input).toBe("not-json");
  });

  it("extractReturnEnvelope only lifts summary/output from plain objects", () => {
    expect(extractReturnEnvelope(undefined)).toStrictEqual({
      value: undefined,
    });
    expect(extractReturnEnvelope("x")).toStrictEqual({ value: "x" });
    expect(extractReturnEnvelope([1])).toStrictEqual({ value: [1] });
    expect(
      extractReturnEnvelope({ summary: "s", output: { a: 1 }, extra: true })
    ).toStrictEqual({
      value: { summary: "s", output: { a: 1 }, extra: true },
      summary: "s",
      output: { a: 1 },
    });
  });

  it("makeNodeId embeds runId + ordinal + a short uuid suffix", () => {
    const id = makeNodeId("run-1", 3);
    expect(id).toMatch(/^run-1:3:[0-9a-f]{6}$/u);
  });
});

describe("applyRetention / usageCloseFields / open+closeRunNode", () => {
  it("applyRetention maps history keep policies onto pruneAutomation", () => {
    const store = {
      pruneAutomation: vi.fn<ConversationStore["pruneAutomation"]>(),
    };
    applyRetention(store as never, "app/a", undefined);
    expect(store.pruneAutomation).not.toHaveBeenCalled();

    applyRetention(store as never, "app/a", { keep: "all" });
    expect(store.pruneAutomation).not.toHaveBeenCalled();

    applyRetention(store as never, "app/a", { keep: "errors" });
    expect(store.pruneAutomation).toHaveBeenCalledWith("app/a", {
      errorsOnly: true,
    });

    applyRetention(store as never, "app/a", { keep: { count: 5 } });
    expect(store.pruneAutomation).toHaveBeenCalledWith("app/a", { count: 5 });

    applyRetention(store as never, "app/a", { keep: { days: 30 } });
    expect(store.pruneAutomation).toHaveBeenCalledWith("app/a", { days: 30 });
  });

  it("usageCloseFields folds a usage stream event into close args", () => {
    expect(usageCloseFields(undefined)).toStrictEqual({});
    expect(
      usageCloseFields({
        type: "usage",
        harness: "codex",
        model: "m",
        inputTokens: 1,
        outputTokens: 2,
        costUsd: 0.5,
      })
    ).toMatchObject({
      model: "m",
      harness: "codex",
      inputTokens: 1,
      outputTokens: 2,
      costUsd: 0.5,
      costSource: "harness",
    });
  });

  it("openRunNode + closeRunNode write the ledger and emit without throwing on store failures", () => {
    const store = {
      openItem: vi.fn<ConversationStore["openItem"]>(() => {
        throw new Error("open boom");
      }),
      closeItem: vi.fn<ConversationStore["closeItem"]>(() => {
        throw new Error("close boom");
      }),
    };
    const emit = vi.fn<RunEventSink>(() => {
      throw new Error("emit boom");
    });
    // Swallowed failures — handler must not die on audit.
    const nodeId = openRunNode({
      store: store as never,
      emit,
      runId: "r1",
      ordinal: 0,
      kind: "tool",
      name: "vault_sql",
      args: { sql: "select 1" },
      started: 1,
    });
    expect(nodeId.startsWith("r1:0:")).toBe(true);

    closeRunNode({
      store: store as never,
      emit,
      nodeId,
      ordinal: 0,
      ok: true,
      result: { rows: [] },
      started: 1,
      ended: 5,
    });
    expect(store.openItem).toHaveBeenCalledWith({
      itemId: nodeId,
      turnId: "r1",
      ordinal: 0,
      kind: "tool",
      name: "vault_sql",
      argsJson: JSON.stringify({ sql: "select 1" }),
      startedAt: 1,
    });
    expect(store.closeItem).toHaveBeenCalledWith({
      itemId: nodeId,
      ok: true,
      outputJson: JSON.stringify({ rows: [] }),
      endedAt: 5,
      durationMs: 4,
    });

    // Happy path still emits item.start / item.end when store+emit succeed.
    const goodStore = {
      openItem: vi.fn<ConversationStore["openItem"]>(),
      closeItem: vi.fn<ConversationStore["closeItem"]>(),
    };
    const events: unknown[] = [];
    const id = openRunNode({
      store: goodStore as never,
      emit: (e) => events.push(e),
      runId: "r2",
      ordinal: 1,
      kind: "step",
      started: 10,
    });
    closeRunNode({
      store: goodStore as never,
      emit: (e) => events.push(e),
      nodeId: id,
      ordinal: 1,
      ok: false,
      error: "nope",
      started: 10,
      ended: 20,
    });
    expect(events).toStrictEqual([
      { type: "item.start", itemId: id, ordinal: 1, kind: "step" },
      {
        type: "item.end",
        itemId: id,
        ordinal: 1,
        ok: false,
        error: "nope",
        durationMs: 10,
      },
    ]);
  });

  it("noopRunEventSink is callable", () => {
    expect(() =>
      noopRunEventSink({
        type: "item.start",
        itemId: "i0",
        ordinal: 0,
        kind: "step",
      })
    ).not.toThrow();
  });
});
