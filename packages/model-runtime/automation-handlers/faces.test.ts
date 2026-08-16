/*
 * Source-level contract for the face-detection recognition handler (#781).
 *
 * `packages/server/src/automation/manifest/enricher-templates.test.ts` owns the
 * bundled copy's spine: a per-item consent request derives and drains, and a
 * target-less request walks the vault behind its own cursor. This file owns
 * the model-availability gate, the consent-queue edge cases (missing target,
 * already-stamped target, capacity exhaustion), the consent-cursor sweep that
 * re-derives on a model bump, and the detector call/write shapes.
 */
import { beforeEach, describe, expect, it } from "vitest";

import handler, { setFacesRuntimeForTests } from "./faces.js";
import { bytesContent, createHarness } from "./handler-harness.js";

const MODEL = "yunet-sface@1";
const FACES = [{ box: [1, 2, 3, 4], embedding: [0.5] }];

function asset(id: string): Record<string, unknown> {
  return {
    asset_id: id,
    kind: "photo",
    content_id: `c-${id}`,
    deleted_at: null,
    width: 400,
    height: 300,
  };
}

function request(id: string, targetId: string | null): Record<string, unknown> {
  return {
    request_id: id,
    target_id: targetId,
    capability: "faces",
    drained_at: null,
  };
}

function stamp(targetId: string, model: string): Record<string, unknown> {
  return { target_id: targetId, variant: "faces", model };
}

function previews(
  ids: string[]
): Record<string, ReturnType<typeof bytesContent>> {
  return Object.fromEntries(
    ids.map((id) => [`c-${id}:preview`, bytesContent()])
  );
}

describe("faces handler", () => {
  beforeEach(() => {
    setFacesRuntimeForTests({
      weightsPresent: () => true,
      infer: (item: { id: string }) =>
        Promise.resolve({ id: item.id, faces: FACES }),
    });
  });

  describe("model availability", () => {
    it("reports an honest skip and reads nothing when the weights are absent", async () => {
      setFacesRuntimeForTests({ weightsPresent: () => false });
      const harness = createHarness({
        entities: { "enrich.request": [request("r1", "a1")] },
      });

      const result = await handler({ ctx: harness.ctx });

      expect(result).toStrictEqual({
        summary: "faces skipped — automation model assets unavailable",
      });
      expect(harness.reads).toStrictEqual([]);
    });
  });

  describe("detector wiring", () => {
    it("passes the original geometry to the detector and writes its faces verbatim", async () => {
      const calls: Record<string, unknown>[] = [];
      setFacesRuntimeForTests({
        weightsPresent: () => true,
        infer: (item: Record<string, unknown>) => {
          calls.push(item);
          return Promise.resolve({ id: item.id, faces: FACES });
        },
      });
      const harness = createHarness({
        entities: {
          "enrich.request": [request("r1", "a1")],
          "media.asset": [asset("a1")],
          "enrich.derivation": [],
        },
        content: previews(["a1"]),
        state: { model: MODEL },
      });

      await handler({ ctx: harness.ctx });

      expect(calls).toStrictEqual([
        {
          id: "a1",
          bytes: "Zml4dHVyZQ==",
          mediaType: "image/jpeg",
          originalWidth: 400,
          originalHeight: 300,
        },
      ]);
      expect(harness.invokes[0]).toStrictEqual({
        command: "enrich.upsert_faces",
        input: { asset_id: "a1", model: MODEL, faces: FACES },
        purpose: "dpv:ServiceProvision",
      });
    });

    it("fails the fire when the detector returns no faces array", async () => {
      setFacesRuntimeForTests({
        weightsPresent: () => true,
        infer: () => Promise.resolve({ id: "a1", error: "detector crashed" }),
      });
      const harness = createHarness({
        entities: {
          "enrich.request": [request("r1", "a1")],
          "media.asset": [asset("a1")],
          "enrich.derivation": [],
        },
        content: previews(["a1"]),
        state: { model: MODEL },
      });

      await expect(handler({ ctx: harness.ctx })).rejects.toThrow(
        "detector crashed"
      );
    });
  });

  describe("consent queue", () => {
    it("drains a request whose target asset is gone without deriving anything", async () => {
      const harness = createHarness({
        entities: {
          "enrich.request": [request("r1", "missing")],
          "media.asset": [],
          "enrich.derivation": [],
        },
        state: { model: MODEL },
      });

      const result = await handler({ ctx: harness.ctx });

      expect(result.output).toMatchObject({
        derived: 0,
        skipped: 1,
        drained: 1,
      });
      expect(harness.invokes).toStrictEqual([
        {
          command: "enrich.mark_requests_drained",
          input: { request_ids: ["r1"] },
          purpose: "dpv:ServiceProvision",
        },
      ]);
    });

    it("never rebuilds clusters when a fire derives nothing", async () => {
      const harness = createHarness({
        entities: {
          "enrich.request": [request("r1", "a1")],
          "media.asset": [asset("a1")],
          "enrich.derivation": [stamp("a1", MODEL)],
        },
        state: { model: MODEL, consentCursor: "zzz" },
      });

      const result = await handler({ ctx: harness.ctx });

      expect(result.output).toMatchObject({
        derived: 0,
        skipped: 1,
        drained: 1,
      });
      expect(harness.invokes.map((entry) => entry.command)).toStrictEqual([
        "enrich.mark_requests_drained",
      ]);
      expect(harness.contentRequests).toStrictEqual([]);
    });

    it("leaves a vault-wide request undrained and re-arms when it fills the batch", async () => {
      const ids = Array.from(
        { length: 16 },
        (_, index) => `a${String(index).padStart(2, "0")}`
      );
      const harness = createHarness({
        entities: {
          "enrich.request": [request("vault-wide", null)],
          "media.asset": ids.map((id) => asset(id)),
          "enrich.derivation": [],
        },
        content: previews(ids),
        state: { model: MODEL, consentCursor: "zzz" },
      });

      const result = await handler({ ctx: harness.ctx });

      expect(result.output).toMatchObject({
        derived: 16,
        drained: 0,
        rearm: true,
      });
      expect(harness.invokes.map((entry) => entry.command)).toStrictEqual([
        ...Array.from({ length: 16 }, () => "enrich.upsert_faces"),
        "enrich.rebuild_face_clusters",
      ]);
      expect(harness.state.get("requestCursor:vault-wide")).toBe("a15");
    });
  });

  describe("consent-cursor sweep", () => {
    it("seeds past the newest stamp at the current model on the first fire", async () => {
      const harness = createHarness({
        entities: {
          "media.asset": [asset("a1")],
          "enrich.derivation": [stamp("a1", MODEL)],
        },
      });

      const result = await handler({ ctx: harness.ctx });

      expect(result.output).toMatchObject({ derived: 0, skipped: 0 });
      expect(harness.state.get("consentCursor")).toBe("a1");
      expect(harness.contentRequests).toStrictEqual([]);
    });

    it("re-derives previously consented assets after a model bump", async () => {
      const harness = createHarness({
        entities: {
          "media.asset": [asset("a1")],
          "enrich.derivation": [stamp("a1", "yunet-old@1")],
        },
        content: previews(["a1"]),
        state: { model: "yunet-old@1", consentCursor: "zzz" },
      });

      const result = await handler({ ctx: harness.ctx });

      expect(result.output).toMatchObject({ derived: 1, model: MODEL });
      expect(harness.state.get("consentCursor")).toBe("a1");
    });

    it("does not derive an asset twice when its request and its stamp both land in one fire", async () => {
      const harness = createHarness({
        entities: {
          "enrich.request": [request("r1", "a1")],
          "media.asset": [asset("a1")],
          "enrich.derivation": [stamp("a1", "yunet-old@1")],
        },
        content: previews(["a1"]),
        state: { model: "yunet-old@1", consentCursor: "" },
      });

      const result = await handler({ ctx: harness.ctx });

      expect(result.output).toMatchObject({ derived: 1, drained: 1 });
      expect(
        harness.invokes.filter(
          (entry) => entry.command === "enrich.upsert_faces"
        )
      ).toHaveLength(1);
    });
  });
});
