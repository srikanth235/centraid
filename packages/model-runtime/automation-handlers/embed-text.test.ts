import { beforeEach, describe, expect, it } from "vitest";

import handler, { setEmbedTextRuntimeForTests } from "./embed-text.js";
import { createHarness, textContent } from "./handler-harness.js";

const MODEL = "clip-vit-b-32@1";
const VECTOR = [0.25, -0.5];

function derivative(id: string, contentId: string): Record<string, unknown> {
  return { derivative_id: id, content_id: contentId, variant: "text" };
}

function stamp(
  targetId: string,
  extra: Record<string, unknown>
): Record<string, unknown> {
  return { target_id: targetId, variant: "embedding", ...extra };
}

describe("embed-text handler", () => {
  beforeEach(() => {
    setEmbedTextRuntimeForTests({
      weightsPresent: () => true,
      infer: (item: { id: string }) =>
        Promise.resolve({ id: item.id, vector: VECTOR }),
    });
  });

  describe("model availability", () => {
    it("reports an honest skip and reads nothing when the weights are absent", async () => {
      setEmbedTextRuntimeForTests({ weightsPresent: () => false });
      const harness = createHarness({
        entities: { "core.content_derivative": [derivative("d1", "c1")] },
      });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(result).toStrictEqual({
        summary: "text embedding skipped — model assets unavailable",
      });
      expect(harness.reads).toStrictEqual([]);
      expect(harness.invokes).toStrictEqual([]);
    });
  });

  describe("query input", () => {
    it("embeds a trimmed query and returns the vector without writing to the vault", async () => {
      const embedded: string[] = [];
      setEmbedTextRuntimeForTests({
        weightsPresent: () => true,
        infer: (item: { id: string; text: string }) => {
          embedded.push(item.text);
          return Promise.resolve({ id: item.id, vector: VECTOR });
        },
      });
      const harness = createHarness({ input: { query: "  beach sunset \n" } });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(result).toStrictEqual({
        summary: "embedded one search query",
        output: { model: MODEL, vector: VECTOR },
      });
      expect(embedded).toStrictEqual(["beach sunset"]);
      expect(harness.invokes).toStrictEqual([]);
      expect(harness.state.get("cursor")).toBeUndefined();
    });

    it("refuses a whitespace-only query instead of embedding an empty string", async () => {
      const harness = createHarness({ input: { query: "   " } });

      await expect(
        handler({ ctx: harness.ctx, log: harness.log })
      ).rejects.toThrow("text embedding query is empty");
    });

    it("fails the fire when the query inference returns no vector", async () => {
      setEmbedTextRuntimeForTests({
        weightsPresent: () => true,
        infer: () =>
          Promise.resolve({ id: "query", error: "tokenizer missing" }),
      });
      const harness = createHarness({ input: { query: "beach" } });

      await expect(
        handler({ ctx: harness.ctx, log: harness.log })
      ).rejects.toThrow("tokenizer missing");
    });
  });

  describe("cursor seeding", () => {
    it("seeds past a library already embedded at the current model and source version", async () => {
      const harness = createHarness({
        entities: {
          "core.content_derivative": [
            derivative("d1", "c1"),
            derivative("d2", "c2"),
          ],
          "enrich.derivation": [
            stamp("c2", { model: MODEL, source_version: "d2" }),
          ],
        },
      });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(result.output).toStrictEqual({
        derived: 0,
        skipped: 0,
        model: MODEL,
        rearm: false,
      });
      expect(harness.state.get("cursor")).toBe("d2");
      expect(harness.invokes).toStrictEqual([]);
    });

    it("starts from the beginning when the newest derivative is not yet embedded", async () => {
      const harness = createHarness({
        entities: {
          "core.content_derivative": [
            derivative("d1", "c1"),
            derivative("d2", "c2"),
          ],
          "enrich.derivation": [],
        },
        content: {
          "c1:text": textContent("one"),
          "c2:text": textContent("two"),
        },
      });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(result.output).toMatchObject({ derived: 2, skipped: 0 });
      expect(harness.state.get("cursor")).toBe("d2");
    });

    it("rewalks from the beginning when the model changes under a live cursor", async () => {
      const harness = createHarness({
        entities: {
          "core.content_derivative": [derivative("d1", "c1")],
          "enrich.derivation": [
            stamp("c1", { model: "clip-old@1", source_version: "d1" }),
          ],
        },
        content: { "c1:text": textContent("one") },
        state: { model: "clip-old@1", cursor: "d9" },
      });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(result.output).toMatchObject({ derived: 1, model: MODEL });
      expect(harness.state.get("cursor")).toBe("d1");
      expect(harness.invokes[0]?.input).toMatchObject({
        entity_type: "core.content_item",
        entity_id: "c1",
        capability: "embed-text",
        source_version: "d1",
        vector: VECTOR,
      });
    });
  });

  describe("batch walk", () => {
    it("skips an item whose column-form stamp already names the current source version", async () => {
      const harness = createHarness({
        entities: {
          "core.content_derivative": [derivative("d2", "c1")],
          "enrich.derivation": [
            stamp("c1", { model: MODEL, source_version: "d2" }),
          ],
        },
        state: { model: MODEL, cursor: "d1" },
      });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(result.output).toMatchObject({ derived: 0, skipped: 1 });
      expect(harness.invokes).toStrictEqual([]);
      expect(harness.contentRequests).toStrictEqual([]);
    });

    it("counts a vectorless item as a skip, logs it, and still advances the cursor", async () => {
      setEmbedTextRuntimeForTests({
        weightsPresent: () => true,
        infer: () => Promise.resolve({ id: "c1", error: "empty text" }),
      });
      const harness = createHarness({
        entities: {
          "core.content_derivative": [derivative("d2", "c1")],
          "enrich.derivation": [],
        },
        content: { "c1:text": textContent("one") },
        state: { model: MODEL, cursor: "d1" },
      });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(result.output).toMatchObject({ derived: 0, skipped: 1 });
      expect(harness.logs).toStrictEqual(["content c1: no text vector"]);
      expect(harness.state.get("cursor")).toBe("d2");
    });

    it("re-arms and reports the bounded batch when the read comes back full", async () => {
      const rows = Array.from({ length: 16 }, (_, index) =>
        derivative(`d${String(index).padStart(2, "0")}`, `c${index}`)
      );
      const content = Object.fromEntries(
        rows.map((row) => [
          `${String(row.content_id)}:text`,
          textContent("body"),
        ])
      );
      const harness = createHarness({
        entities: { "core.content_derivative": rows, "enrich.derivation": [] },
        content,
        state: { model: MODEL, cursor: "" },
      });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(result.summary).toBe(
        "embedded 16 texts; skipped 0; bounded batch 16/16"
      );
      expect(result.output).toMatchObject({ derived: 16, rearm: true });
    });

    it("reads transcript derivatives alongside text ones", async () => {
      const harness = createHarness({
        entities: {
          "core.content_derivative": [
            { derivative_id: "d1", content_id: "c1", variant: "transcript" },
            { derivative_id: "d2", content_id: "c2", variant: "caption" },
          ],
          "enrich.derivation": [],
        },
        content: { "c1:transcript": textContent("spoken") },
        state: { model: MODEL, cursor: "" },
      });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(result.output).toMatchObject({ derived: 1, skipped: 0 });
      expect(
        harness.invokes.map((entry) => entry.input.entity_id)
      ).toStrictEqual(["c1"]);
    });
  });
});
