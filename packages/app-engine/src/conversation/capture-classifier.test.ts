import { describe, expect, it, vi } from "vitest";

import {
  classifyCaptureWithAgent,
  parseAgentCapturePreview,
} from "./capture-classifier.js";

describe("capture agent fallback", () => {
  it("accepts only the bounded preview schema", () => {
    expect(
      parseAgentCapturePreview(
        '```json\n{"kind":"event","title":"Design review","durationMinutes":30}\n```'
      )
    ).toStrictEqual({
      kind: "event",
      title: "Design review",
      durationMinutes: 30,
    });
    expect(parseAgentCapturePreview('{"kind":"password"}')).toBeUndefined();
    expect(parseAgentCapturePreview("not json")).toBeUndefined();
  });

  it("runs without tools and parses the streamed JSON", async () => {
    const runTurn = vi.fn<
      Parameters<typeof classifyCaptureWithAgent>[0]["runTurn"]
    >(async (input) => {
      input.onEvent({
        type: "assistant.delta",
        delta: '{"kind":"task","title":"Call Priya"}',
      });
      input.onEvent({ type: "final", text: "" });
      return {
        harnessKind: "codex",
        text: "",
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        contextWindow: 0,
        costUsd: 0,
        durationMs: 1,
        toolCalls: [],
      };
    });
    await expect(
      classifyCaptureWithAgent({
        runTurn,
        harnessPrefs: { kind: "codex" },
        cwd: "/tmp",
        text: "Maybe call Priya",
      })
    ).resolves.toMatchObject({ kind: "task" });
    expect(runTurn.mock.calls[0]?.[0].toolContext).toBeUndefined();
  });
});
