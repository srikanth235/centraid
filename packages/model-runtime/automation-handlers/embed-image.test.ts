import { beforeEach, describe, expect, it } from "vitest";

import handler, { setEmbedImageRuntimeForTests } from "./embed-image.js";
import { bytesContent, createHarness } from "./handler-harness.js";

const MODEL = "clip-vit-b-32@1";
const VECTOR = [0.1, 0.2];

function asset(
  id: string,
  kind = "photo",
  contentId = `c-${id}`
): Record<string, unknown> {
  return { asset_id: id, kind, content_id: contentId, deleted_at: null };
}

function stamp(targetId: string, model: string): Record<string, unknown> {
  return { target_id: targetId, variant: "embedding", model };
}

describe("embed-image handler", () => {
  beforeEach(() => {
    setEmbedImageRuntimeForTests({
      weightsPresent: () => true,
      infer: (item: { id: string }) =>
        Promise.resolve({ id: item.id, vector: VECTOR }),
    });
  });

  describe("model availability", () => {
    it("reports an honest skip and reads nothing when the weights are absent", async () => {
      setEmbedImageRuntimeForTests({ weightsPresent: () => false });
      const harness = createHarness({
        entities: { "media.asset": [asset("a1")] },
      });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(result).toStrictEqual({
        summary: "image embedding skipped — model assets unavailable",
      });
      expect(harness.reads).toStrictEqual([]);
    });
  });

  describe("cursor seeding", () => {
    it("seeds past a library already embedded at the current model", async () => {
      const harness = createHarness({
        entities: {
          "media.asset": [asset("a1"), asset("a2")],
          "enrich.derivation": [stamp("a2", MODEL)],
        },
      });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(result.output).toStrictEqual({
        derived: 0,
        skipped: 0,
        model: MODEL,
        rearm: false,
      });
      expect(harness.state.get("cursor")).toBe("a2");
      expect(harness.contentRequests).toStrictEqual([]);
    });

    it("starts from the beginning when the newest asset carries another model's stamp", async () => {
      const harness = createHarness({
        entities: {
          "media.asset": [asset("a1")],
          "enrich.derivation": [stamp("a1", "clip-old@1")],
        },
        content: { "c-a1:preview": bytesContent() },
      });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(result.output).toMatchObject({ derived: 1, skipped: 0 });
      expect(harness.state.get("cursor")).toBe("a1");
    });

    it("rewalks from the beginning when the model changes under a live cursor", async () => {
      const harness = createHarness({
        entities: {
          "media.asset": [asset("a1")],
          "enrich.derivation": [],
        },
        content: { "c-a1:preview": bytesContent() },
        state: { model: "clip-old@1", cursor: "a9" },
      });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(result.output).toMatchObject({ derived: 1, model: MODEL });
      expect(harness.state.get("cursor")).toBe("a1");
    });
  });

  describe("batch walk", () => {
    it("writes the vector against the asset with no source version", async () => {
      const harness = createHarness({
        entities: {
          "media.asset": [asset("a1", "scan")],
          "enrich.derivation": [],
        },
        content: { "c-a1:preview": bytesContent("image/png") },
        state: { model: MODEL, cursor: "" },
      });

      await handler({ ctx: harness.ctx, log: harness.log });

      expect(harness.invokes).toStrictEqual([
        {
          command: "enrich.upsert_embedding",
          input: {
            entity_type: "media.asset",
            entity_id: "a1",
            model: MODEL,
            vector: VECTOR,
            capability: "embed-image",
          },
          purpose: "dpv:ServiceProvision",
        },
      ]);
      expect(harness.contentRequests).toStrictEqual([
        {
          contentId: "c-a1",
          variant: "preview",
          maxBytes: 4 * 1024 * 1024,
          purpose: "dpv:ServiceProvision",
        },
      ]);
    });

    it("skips a non-image asset the read returned but still advances past it", async () => {
      const harness = createHarness({
        entities: {
          "media.asset": [asset("a1", "video"), asset("a2", "photo")],
          "enrich.derivation": [],
        },
        content: { "c-a2:preview": bytesContent() },
        state: { model: MODEL, cursor: "" },
      });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(result.output).toMatchObject({ derived: 1, skipped: 1 });
      expect(harness.state.get("cursor")).toBe("a2");
      expect(
        harness.contentRequests.map((request) => request.contentId)
      ).toStrictEqual(["c-a2"]);
    });

    it("skips an asset already stamped at the current model without reading its preview", async () => {
      const harness = createHarness({
        entities: {
          "media.asset": [asset("a1")],
          "enrich.derivation": [stamp("a1", MODEL)],
        },
        state: { model: MODEL, cursor: "" },
      });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(result.output).toMatchObject({ derived: 0, skipped: 1 });
      expect(harness.contentRequests).toStrictEqual([]);
    });

    it("counts a vectorless asset as a skip, logs it, and advances the cursor", async () => {
      setEmbedImageRuntimeForTests({
        weightsPresent: () => true,
        infer: () => Promise.resolve({ id: "a1", error: "decode failed" }),
      });
      const harness = createHarness({
        entities: { "media.asset": [asset("a1")], "enrich.derivation": [] },
        content: { "c-a1:preview": bytesContent() },
        state: { model: MODEL, cursor: "" },
      });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(result.output).toMatchObject({ derived: 0, skipped: 1 });
      expect(harness.logs).toStrictEqual(["asset a1: no image vector"]);
      expect(harness.state.get("cursor")).toBe("a1");
    });

    it("re-arms and reports the bounded batch when the read comes back full", async () => {
      const assets = Array.from({ length: 16 }, (_, index) =>
        asset(`a${String(index).padStart(2, "0")}`)
      );
      const content = Object.fromEntries(
        assets.map((row) => [
          `${String(row.content_id)}:preview`,
          bytesContent(),
        ])
      );
      const harness = createHarness({
        entities: { "media.asset": assets, "enrich.derivation": [] },
        content,
        state: { model: MODEL, cursor: "" },
      });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(result.summary).toBe(
        "embedded 16 images; skipped 0; bounded batch 16/16"
      );
      expect(result.output).toMatchObject({ derived: 16, rearm: true });
    });
  });
});
