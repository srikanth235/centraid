import { describe, expect, it, vi } from "vitest";

import {
  classifyCaptureWithHarness,
  parseCapturePreview,
} from "./capture-classifier.js";

describe("capture harness fallback", () => {
  it("accepts only the bounded preview schema", () => {
    expect(
      parseCapturePreview(
        '```json\n{"kind":"event","title":"Design review","durationMinutes":30}\n```'
      )
    ).toStrictEqual({
      kind: "event",
      title: "Design review",
      durationMinutes: 30,
    });
    expect(parseCapturePreview('{"kind":"password"}')).toBeUndefined();
    expect(parseCapturePreview("not json")).toBeUndefined();
  });

  it("runs without tools and parses the streamed JSON", async () => {
    const runTurn = vi.fn<
      Parameters<typeof classifyCaptureWithHarness>[0]["runTurn"]
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
      classifyCaptureWithHarness({
        runTurn,
        harnessPrefs: { kind: "codex" },
        cwd: "/tmp",
        text: "Maybe call Priya",
        egressConsent: () => true,
      })
    ).resolves.toMatchObject({ kind: "task" });
    expect(runTurn.mock.calls[0]?.[0].toolContext).toBeUndefined();
    expect(runTurn.mock.calls[0]?.[0].permissionPolicy).toBe("deny");
  });

  it("does not classify when provider egress is unconsented", async () => {
    const runTurn =
      vi.fn<Parameters<typeof classifyCaptureWithHarness>[0]["runTurn"]>();
    await expect(
      classifyCaptureWithHarness({
        runTurn,
        harnessPrefs: { kind: "codex" },
        cwd: "/tmp",
        text: "Maybe call Priya",
        egressConsent: () => false,
      })
    ).rejects.toMatchObject({ code: "provider-egress-consent-required" });
    expect(runTurn).not.toHaveBeenCalled();
  });
});
