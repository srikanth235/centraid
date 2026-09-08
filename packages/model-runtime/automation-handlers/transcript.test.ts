/*
 * Source-level contract for the ASR recognition handler (#781).
 *
 * `packages/server/src/automation/manifest/enricher-templates.test.ts` owns the
 * bundled copy's spine: the typed `core.set_extracted_text` write against the
 * bounded original, the oversized-original permanent skip, the empty-speech
 * skip, and the throw when the original cannot be read. This file owns the
 * model-availability gate, the content-id keying of the derivation stamp,
 * cursor seeding and the model-change rewalk, the two-item batch ceiling, and
 * the ASR error path.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { bytesContent, createHarness } from "./handler-harness.js";
import handler, { setTranscriptRuntimeForTests } from "./transcript.js";

const MODEL = "whisper-tiny.en-q8@1";

function asset(
  id: string,
  kind = "audio",
  contentId = `c-${id}`
): Record<string, unknown> {
  return { asset_id: id, kind, content_id: contentId, deleted_at: null };
}

function stamp(targetId: string, model: string): Record<string, unknown> {
  return { target_id: targetId, variant: "transcript", model };
}

describe("transcript handler", () => {
  beforeEach(() => {
    setTranscriptRuntimeForTests({
      weightsPresent: () => true,
      transcribe: (item: { id: string }) =>
        Promise.resolve({ id: item.id, text: "  spoken words  " }),
    });
  });

  describe("model availability", () => {
    it("reports an honest skip and reads nothing when the weights are absent", async () => {
      setTranscriptRuntimeForTests({ weightsPresent: () => false });
      const harness = createHarness({
        entities: { "media.asset": [asset("a1")] },
      });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(result).toStrictEqual({
        summary: "transcript skipped — automation model assets unavailable",
      });
      expect(harness.reads).toStrictEqual([]);
    });
  });

  describe("stamp keying", () => {
    it("skips an asset whose CONTENT id carries the current model's stamp", async () => {
      const harness = createHarness({
        entities: {
          "media.asset": [asset("a1")],
          "enrich.derivation": [stamp("c-a1", MODEL)],
        },
        state: { model: MODEL, cursor: "" },
      });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(result.output).toMatchObject({ derived: 0, skipped: 1 });
      expect(harness.contentRequests).toStrictEqual([]);
    });

    it("transcribes an asset whose ASSET id was stamped but whose content id was not", async () => {
      const harness = createHarness({
        entities: {
          "media.asset": [asset("a1")],
          "enrich.derivation": [stamp("a1", MODEL)],
        },
        content: { "c-a1:original": bytesContent("audio/mp4") },
        state: { model: MODEL, cursor: "" },
      });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(result.output).toMatchObject({ derived: 1, skipped: 0 });
      expect(harness.invokes).toStrictEqual([
        {
          command: "core.set_extracted_text",
          input: {
            content_id: "c-a1",
            text: "spoken words",
            variant: "transcript",
            capability: "transcript",
            model: MODEL,
          },
        },
      ]);
    });
  });

  describe("cursor seeding", () => {
    it("seeds past a library already transcribed at the current model", async () => {
      const harness = createHarness({
        entities: {
          "media.asset": [asset("a1"), asset("a2", "video")],
          "enrich.derivation": [stamp("c-a2", MODEL)],
        },
      });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(result.output).toMatchObject({ derived: 0, skipped: 0 });
      expect(harness.state.get("cursor")).toBe("a2");
    });

    it("rewalks from the beginning when the model changes under a live cursor", async () => {
      const harness = createHarness({
        entities: {
          "media.asset": [asset("a1")],
          "enrich.derivation": [stamp("c-a1", "whisper-old@1")],
        },
        content: { "c-a1:original": bytesContent("audio/mp4") },
        state: { model: "whisper-old@1", cursor: "a9" },
      });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(result.output).toMatchObject({ derived: 1, model: MODEL });
      expect(harness.state.get("cursor")).toBe("a1");
    });
  });

  describe("batch ceiling", () => {
    it("transcribes at most two assets a fire and re-arms with the rest pending", async () => {
      const assets = [asset("a1"), asset("a2", "video"), asset("a3")];
      const harness = createHarness({
        entities: { "media.asset": assets, "enrich.derivation": [] },
        content: Object.fromEntries(
          assets.map((row) => [
            `${String(row.content_id)}:original`,
            bytesContent("audio/mp4"),
          ])
        ),
        state: { model: MODEL, cursor: "" },
      });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(result.summary).toBe(
        "transcribed 2; skipped 0; bounded batch 2/2"
      );
      expect(result.output).toMatchObject({ derived: 2, rearm: true });
      expect(harness.state.get("cursor")).toBe("a2");
    });
  });

  describe("failure", () => {
    it("fails the fire when the ASR result carries an error", async () => {
      setTranscriptRuntimeForTests({
        weightsPresent: () => true,
        transcribe: () =>
          Promise.resolve({ id: "c-a1", error: "ffmpeg missing" }),
      });
      const harness = createHarness({
        entities: { "media.asset": [asset("a1")], "enrich.derivation": [] },
        content: { "c-a1:original": bytesContent("audio/mp4") },
        state: { model: MODEL, cursor: "" },
      });

      await expect(
        handler({ ctx: harness.ctx, log: harness.log })
      ).rejects.toThrow("ffmpeg missing");
    });

    it("fails the fire when the ASR call returns nothing at all", async () => {
      setTranscriptRuntimeForTests({
        weightsPresent: () => true,
        transcribe: () => Promise.resolve(undefined),
      });
      const harness = createHarness({
        entities: { "media.asset": [asset("a1")], "enrich.derivation": [] },
        content: { "c-a1:original": bytesContent("audio/mp4") },
        state: { model: MODEL, cursor: "" },
      });

      await expect(
        handler({ ctx: harness.ctx, log: harness.log })
      ).rejects.toThrow("asset a1: ASR returned no result");
    });
  });
});
