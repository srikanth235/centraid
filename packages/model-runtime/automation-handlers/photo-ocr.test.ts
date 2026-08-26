/*
 * Source-level contract for the OCR recognition handler (#781).
 *
 * `packages/server/src/automation/manifest/enricher-templates.test.ts` owns the
 * bundled copy's spine: the deterministic batch write and re-arm, seeding from
 * an existing stamp, the born-digital PDF path against the real pdf.js, and
 * the delegate turn's box stripping plus ACP identity stamp. This file owns
 * the capture input validation, the region canonicalisation arithmetic
 * (confidence range, loose-text fallback, reading order), the delegate
 * refusals and prompt-revision bookkeeping, and the kind filter's effect on
 * the cursor.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { bytesContent, createHarness } from "./handler-harness.js";
import handler, { setPhotoOcrRuntimeForTests } from "./photo-ocr.js";

const MODEL = "pp-ocrv4@1";

interface Region {
  text?: unknown;
  box?: unknown;
  confidence?: unknown;
}

function asset(
  id: string,
  kind = "photo",
  width = 100,
  height = 80
): Record<string, unknown> {
  return {
    asset_id: id,
    kind,
    content_id: `c-${id}`,
    deleted_at: null,
    width,
    height,
  };
}

/** The handler returns one of several shapes; tests read the payload loosely. */
function outputOf(result: unknown): Record<string, unknown> {
  return (result as { output: Record<string, unknown> }).output;
}

/** Fixes the recognizer to one canned reply so only the shaping is under test. */
function recognizing(reply: Record<string, unknown>): void {
  setPhotoOcrRuntimeForTests({
    weightsPresent: () => true,
    recognize: (item: { id: string }) =>
      Promise.resolve({ id: item.id, ...reply }),
  });
}

function capture(
  bytes: unknown = "cmVjZWlwdA==",
  mediaType: unknown = "image/jpeg"
): Record<string, unknown> {
  return { capture: { bytes, mediaType } };
}

describe("photo-ocr handler", () => {
  beforeEach(() => {
    recognizing({ regions: [{ text: "Total", box: [1, 2, 3, 4] }] });
  });

  describe("capture input", () => {
    it("refuses a capture with no content bytes", async () => {
      const harness = createHarness({ input: capture("") });

      await expect(
        handler({ ctx: harness.ctx, log: harness.log })
      ).rejects.toThrow("capture OCR needs base64 content bytes");
    });

    it("refuses a capture whose media type is neither an image nor a PDF", async () => {
      const harness = createHarness({
        input: capture("cmVjZWlwdA==", "text/plain"),
      });

      await expect(
        handler({ ctx: harness.ctx, log: harness.log })
      ).rejects.toThrow("capture OCR needs an image or PDF media type");
    });

    it("falls through to the batch walk when the input carries no capture", async () => {
      const harness = createHarness({
        input: { capture: null },
        entities: { "media.asset": [] },
        state: { selection: `deterministic:${MODEL}:local` },
      });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(result.summary).toBe("OCR derived 0; skipped 0; batch 0/16");
    });
  });

  describe("region canonicalisation", () => {
    it("drops a region whose confidence is outside 0..1 or not a number", async () => {
      recognizing({
        regions: [
          { text: "kept", confidence: 0.5 },
          { text: "too confident", confidence: 1.5 },
          { text: "negative", confidence: -0.1 },
          { text: "unscored", confidence: "high" },
        ] satisfies Region[],
      });
      const harness = createHarness({ input: capture() });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(result.output).toStrictEqual({
        text: "kept",
        engine: "automation",
        model: MODEL,
        confidence: 0.5,
      });
    });

    it("drops a region whose text is not a string", async () => {
      recognizing({
        regions: [{ text: 42 }, { text: "kept" }] satisfies Region[],
      });
      const harness = createHarness({ input: capture() });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(outputOf(result).text).toBe("kept");
    });

    it("accepts a loose text reply with no regions array as one region", async () => {
      recognizing({ text: "loose reading" });
      const harness = createHarness({ input: capture() });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(result).toStrictEqual({
        summary: "Capture OCR completed",
        output: { text: "loose reading", engine: "automation", model: MODEL },
      });
    });

    it("reports no legible text when the loose reply is blank", async () => {
      recognizing({ text: "   " });
      const harness = createHarness({ input: capture() });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(result.summary).toBe("Capture OCR found no legible text");
      expect(outputOf(result).text).toBe("");
    });

    it("reads boxed regions top-to-bottom then left-to-right, not in arrival order", async () => {
      recognizing({
        regions: [
          { text: "lower left", box: [0, 10, 5, 5] },
          { text: "upper right", box: [20, 0, 5, 5] },
          { text: "upper left", box: [0, 0, 5, 5] },
        ] satisfies Region[],
      });
      const harness = createHarness({ input: capture() });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(outputOf(result).text).toBe("upper left\nupper right\nlower left");
    });

    it("keeps arrival order when the recognizer returns no boxes", async () => {
      recognizing({
        regions: [{ text: "first" }, { text: "second" }] satisfies Region[],
      });
      const harness = createHarness({ input: capture() });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(outputOf(result).text).toBe("first\nsecond");
    });
  });

  describe("deterministic batch", () => {
    it("reports an honest skip and reads nothing when the weights are absent", async () => {
      setPhotoOcrRuntimeForTests({ weightsPresent: () => false });
      const harness = createHarness({
        entities: { "media.asset": [asset("a1")] },
      });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(result).toStrictEqual({
        summary: "OCR skipped — automation model assets unavailable",
      });
      expect(harness.reads).toStrictEqual([]);
    });

    it("writes regions without the internal ordering key and averages their confidence", async () => {
      recognizing({
        regions: [
          { text: "Total", box: [0, 0, 10, 10], confidence: 0.9 },
          { text: "42", box: [0, 20, 10, 10], confidence: 0.7 },
        ] satisfies Region[],
      });
      const harness = createHarness({
        entities: { "media.asset": [asset("a1")], "enrich.derivation": [] },
        content: { "c-a1:preview": bytesContent() },
        state: { selection: `deterministic:${MODEL}:local`, cursor: "" },
      });

      await handler({ ctx: harness.ctx, log: harness.log });

      expect(harness.invokes).toStrictEqual([
        {
          command: "core.set_extracted_text",
          input: {
            content_id: "c-a1",
            text: "Total\n42",
            capability: "ocr",
            model: MODEL,
            regions: [
              { text: "Total", box: [0, 0, 10, 10], confidence: 0.9 },
              { text: "42", box: [0, 20, 10, 10], confidence: 0.7 },
            ],
            confidence: 0.8,
          },
          purpose: "dpv:ServiceProvision",
        },
      ]);
    });

    it("advances the cursor past assets the kind filter removed from the batch", async () => {
      const harness = createHarness({
        entities: {
          "media.asset": [asset("a1"), asset("a2", "video")],
          "enrich.derivation": [],
        },
        content: { "c-a1:preview": bytesContent() },
        state: { selection: `deterministic:${MODEL}:local`, cursor: "" },
      });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(result.output).toMatchObject({ derived: 1, skipped: 0 });
      expect(harness.state.get("cursor")).toBe("a2");
      expect(
        harness.contentRequests.map((entry) => entry.contentId)
      ).toStrictEqual(["c-a1"]);
    });
  });

  describe("delegate step", () => {
    const delegateInput = { variant: "delegate", delegateModel: "owner/pin" };

    it("refuses a delegate fire that names no pinned model", async () => {
      const harness = createHarness({ input: { variant: "delegate" } });

      await expect(
        handler({ ctx: harness.ctx, log: harness.log })
      ).rejects.toThrow("delegate OCR requires an explicit pinned model");
    });

    it("refuses a delegate answer that carries no ACP-confirmed model identity", async () => {
      const harness = createHarness({
        input: delegateInput,
        entities: { "media.asset": [asset("a1")], "enrich.derivation": [] },
        delegate: () => ({ regions: [{ text: "Total" }] }),
      });

      await expect(
        handler({ ctx: harness.ctx, log: harness.log })
      ).rejects.toThrow("no ACP-confirmed model identity");
    });

    it("forgets the confirmed model when the selection changes", async () => {
      const harness = createHarness({
        input: delegateInput,
        entities: { "media.asset": [] },
        state: {
          selection: `deterministic:${MODEL}:local`,
          cursor: "a9",
          confirmedModel: "acp-confirmed@7",
        },
      });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(harness.state.get("confirmedModel")).toBeUndefined();
      expect(harness.state.get("cursor")).toBe("");
      expect(harness.state.get("selection")).toBe("delegate:owner/pin:ocr-v1");
      expect(outputOf(result).model).toBe("owner/pin");
    });

    it("skips an asset already delegated at the confirmed model and prompt revision", async () => {
      const harness = createHarness({
        input: delegateInput,
        entities: {
          "media.asset": [asset("a1")],
          "enrich.derivation": [
            {
              target_id: "c-a1",
              variant: "text",
              profile: "built-in",
              model: "acp-confirmed@7",
              payload_json: JSON.stringify({ prompt_rev: "ocr-v1" }),
            },
          ],
        },
        state: {
          selection: "delegate:owner/pin:ocr-v1",
          cursor: "",
          confirmedModel: "acp-confirmed@7",
        },
        delegate: () => {
          throw new Error("a settled asset must not spend a delegate turn");
        },
      });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(result.output).toMatchObject({
        derived: 0,
        skipped: 1,
        model: "acp-confirmed@7",
      });
      expect(harness.delegateCalls).toStrictEqual([]);
    });

    it("re-delegates an asset stamped under a superseded prompt revision", async () => {
      const harness = createHarness({
        input: delegateInput,
        entities: {
          "media.asset": [asset("a1")],
          "enrich.derivation": [
            {
              target_id: "c-a1",
              variant: "text",
              profile: "built-in",
              model: "acp-confirmed@7",
              prompt_rev: "ocr-v0",
            },
          ],
        },
        state: {
          selection: "delegate:owner/pin:ocr-v1",
          cursor: "",
          confirmedModel: "acp-confirmed@7",
        },
        delegate: () => ({
          __centraidModel: "acp-confirmed@7",
          regions: [{ text: "Total" }],
        }),
      });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(result.output).toMatchObject({ derived: 1, skipped: 0 });
      expect(harness.invokes[0]?.input).toMatchObject({ prompt_rev: "ocr-v1" });
    });

    it("asks for the preview under the same bounded budget the local path uses", async () => {
      const harness = createHarness({
        input: delegateInput,
        entities: { "media.asset": [asset("a1")], "enrich.derivation": [] },
        delegate: () => ({
          __centraidModel: "acp-confirmed@7",
          regions: [{ text: "Total" }],
        }),
      });

      await handler({ ctx: harness.ctx, log: harness.log });

      expect(harness.delegateCalls[0]?.content).toStrictEqual([
        { contentId: "c-a1", variant: "preview", maxBytes: 4 * 1024 * 1024 },
      ]);
      expect(harness.contentRequests).toStrictEqual([]);
    });
  });

  // ── the engine profile the run belongs to (issue #807, Wave 5) ──────────
  // Selection lives in policy, not the manifest, so the fire hands the
  // handler the profile it resolved. The handler's job is to keep the LEDGER
  // honest about it: stamp the profile, key the cursor by it, and never
  // stamp a prompt revision it did not send.
  describe("engine profile", () => {
    const delegateInput = { variant: "delegate", delegateModel: "owner/pin" };

    it("stamps the resolved profile on the delegate result", async () => {
      const harness = createHarness({
        input: { ...delegateInput, profileId: "vision-pro" },
        entities: { "media.asset": [asset("a1")], "enrich.derivation": [] },
        delegate: () => ({
          __centraidModel: "acp-confirmed@7",
          regions: [{ text: "Total" }],
        }),
      });

      await handler({ ctx: harness.ctx, log: harness.log });

      expect(harness.invokes[0]?.input).toMatchObject({
        profile: "vision-pro",
        model: "acp-confirmed@7",
        prompt_rev: "ocr-v1",
      });
      // Two profiles are two rows, so the settled-check reads its own.
      expect(
        harness.reads.some((read) =>
          read.where?.some(
            (clause) =>
              clause.column === "profile" && clause.value === "vision-pro"
          )
        )
      ).toBe(true);
    });

    it("keys the cursor by profile so switching engines re-arms it", async () => {
      const harness = createHarness({
        input: { ...delegateInput, profileId: "vision-pro" },
        entities: { "media.asset": [] },
        state: { selection: "delegate:owner/pin:ocr-v1", cursor: "a9" },
      });

      await handler({ ctx: harness.ctx, log: harness.log });

      expect(harness.state.get("selection")).toBe(
        "delegate:owner/pin:ocr-v1:vision-pro"
      );
      expect(harness.state.get("cursor")).toBe("");
    });

    it("leaves the built-in profile's selection key and write byte-identical", async () => {
      const harness = createHarness({
        input: { variant: "deterministic", profileId: "built-in" },
        entities: { "media.asset": [asset("a1")], "enrich.derivation": [] },
        content: { "c-a1:preview": bytesContent() },
      });

      await handler({ ctx: harness.ctx, log: harness.log });

      expect(harness.state.get("selection")).toBe(
        `deterministic:${MODEL}:local`
      );
      expect(harness.invokes[0]?.input).not.toHaveProperty("profile");
    });

    it("refuses a prompt revision the profile pinned but this handler does not ship", async () => {
      const harness = createHarness({
        input: {
          ...delegateInput,
          profileId: "vision-pro",
          promptRev: "ocr-v9",
        },
        entities: { "media.asset": [asset("a1")], "enrich.derivation": [] },
        delegate: () => {
          throw new Error("a refused prompt revision must spend no turn");
        },
      });

      await expect(
        handler({ ctx: harness.ctx, log: harness.log })
      ).rejects.toThrow('pins prompt revision "ocr-v9"');
    });
  });
});
