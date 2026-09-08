/*
 * Source-level contract for the opt-in place-names handler (#816).
 *
 * The lookup's own answers are pinned in `src/gazetteer.test.ts`. This file owns
 * the handler's spine: what it selects, what it refuses to re-examine, the shape
 * of the typed write, the none-marker that makes a miss terminal, the cursor and
 * snapshot rewalk — and, structurally, that neither this source nor the bundle
 * it compiles into can reach the network.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createHarness } from "./handler-harness.js";
import handler from "./place-names.js";

const SNAPSHOT = "2017-02-27";
const SOURCE = "geonames-cities15000";
const BATCH = 64;

/** The seeded roll's Truckee river bend — 18 km from Truckee, CA. */
const TRUCKEE_RIVER = { lat: 39.1682, lng: -120.1429 };
/** Mid-Pacific: nothing within 50 km, so the miss has to be recorded. */
const OPEN_OCEAN = { lat: -30, lng: -140 };

function place(
  id: string,
  coords?: { lat: number; lng: number },
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    place_id: id,
    name: "37.44190, -122.14300",
    geo_lat: coords?.lat ?? null,
    geo_lng: coords?.lng ?? null,
    address_json: null,
    ...extra,
  };
}

describe("place-names handler", () => {
  describe("naming a coordinate", () => {
    it("writes the settlement through the typed command and nothing else", async () => {
      const harness = createHarness({
        entities: { "core.place": [place("p1", TRUCKEE_RIVER)] },
      });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(harness.invokes).toStrictEqual([
        {
          command: "media.set_place_gazetteer",
          input: {
            place_id: "p1",
            name: "Truckee, CA",
            admin: "CA",
            country: "US",
            distance_km: 18.1,
            source: SOURCE,
            snapshot: SNAPSHOT,
          },
        },
      ]);
      expect(result.output).toStrictEqual({
        named: 1,
        none: 0,
        skipped: 0,
        snapshot: SNAPSHOT,
        rearm: false,
      });
      expect(result.summary).toContain("named 1 places");
    });

    it("never sends a place name or a kind to any command", async () => {
      // The member-authority invariant from the handler's side: whatever it
      // writes, `name` and `kind` on `core_place` are not in the payload. The
      // command layer's half is `media-gazetteer.test.ts`.
      const harness = createHarness({
        entities: {
          "core.place": [
            place("p1", TRUCKEE_RIVER, { name: "Grandma's house" }),
          ],
        },
      });

      await handler({ ctx: harness.ctx, log: harness.log });

      for (const invoke of harness.invokes) {
        expect(invoke.command).toBe("media.set_place_gazetteer");
        expect(Object.keys(invoke.input)).not.toContain("kind");
        expect(invoke.input.name).toBe("Truckee, CA");
        expect(invoke.input.place_id).toBe("p1");
      }
    });
  });

  describe("a miss is a result", () => {
    it("records a none-marker rather than leaving the row to be rescanned", async () => {
      const harness = createHarness({
        entities: { "core.place": [place("p1", OPEN_OCEAN)] },
      });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(harness.invokes).toStrictEqual([
        {
          command: "media.set_place_gazetteer",
          input: { place_id: "p1", source: SOURCE, snapshot: SNAPSHOT },
        },
      ]);
      expect(result.output).toMatchObject({ named: 0, none: 1 });
    });

    it("leaves an already-marked miss alone on the next fire", async () => {
      const harness = createHarness({
        entities: {
          "core.place": [
            place("p1", OPEN_OCEAN, {
              address_json: JSON.stringify({
                gazetteer: {
                  none: true,
                  source: SOURCE,
                  snapshot: SNAPSHOT,
                  checked_at: "2026-08-17T00:00:00.000Z",
                },
              }),
            }),
          ],
        },
      });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(harness.invokes).toStrictEqual([]);
      expect(result.output).toMatchObject({ named: 0, none: 0, skipped: 1 });
    });
  });

  describe("selection", () => {
    it("skips a place with no geography to look up", async () => {
      const harness = createHarness({
        entities: { "core.place": [place("p1")] },
      });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(harness.invokes).toStrictEqual([]);
      expect(result.output).toMatchObject({ skipped: 1 });
    });

    it("skips a row that already carries a hit", async () => {
      const harness = createHarness({
        entities: {
          "core.place": [
            place("p1", TRUCKEE_RIVER, {
              address_json: JSON.stringify({
                street: "10 Somewhere Rd",
                gazetteer: { name: "Truckee, CA", checked_at: "2026-01-01" },
              }),
            }),
          ],
        },
      });

      await handler({ ctx: harness.ctx, log: harness.log });

      expect(harness.invokes).toStrictEqual([]);
    });

    it("treats an unparseable address blob as unchecked rather than crashing", async () => {
      const harness = createHarness({
        entities: {
          "core.place": [
            place("p1", TRUCKEE_RIVER, { address_json: "{not json" }),
          ],
        },
      });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(result.output).toMatchObject({ named: 1 });
    });

    it("advances the cursor and asks to re-arm on a full batch", async () => {
      const rows = Array.from({ length: BATCH }, (_, i) =>
        place(`p${String(i).padStart(3, "0")}`, TRUCKEE_RIVER)
      );
      const harness = createHarness({ entities: { "core.place": rows } });

      const result = await handler({ ctx: harness.ctx, log: harness.log });

      expect(harness.reads[0]?.limit).toBe(BATCH);
      expect(harness.state.get("cursor")).toBe(
        `p${String(BATCH - 1).padStart(3, "0")}`
      );
      expect(result.output).toMatchObject({ named: BATCH, rearm: true });
    });

    it("resumes past the cursor on the next fire", async () => {
      const harness = createHarness({
        entities: {
          "core.place": [place("p1", TRUCKEE_RIVER), place("p2", OPEN_OCEAN)],
        },
        state: { cursor: "p1", snapshot: SNAPSHOT },
      });

      await handler({ ctx: harness.ctx, log: harness.log });

      expect(harness.invokes.map((i) => i.input.place_id)).toStrictEqual([
        "p2",
      ]);
    });
  });

  describe("the dataset is the selection key", () => {
    it("rewalks from the beginning when the snapshot changes", async () => {
      const harness = createHarness({
        entities: { "core.place": [place("p1", TRUCKEE_RIVER)] },
        state: { cursor: "p9", snapshot: "1999-01-01" },
      });

      await handler({ ctx: harness.ctx, log: harness.log });

      expect(harness.state.get("snapshot")).toBe(SNAPSHOT);
      expect(harness.invokes.map((i) => i.input.place_id)).toStrictEqual([
        "p1",
      ]);
    });

    it("keeps the cursor when the snapshot is unchanged", async () => {
      const harness = createHarness({
        entities: { "core.place": [place("p1", TRUCKEE_RIVER)] },
        state: { cursor: "p0", snapshot: SNAPSHOT },
      });

      await handler({ ctx: harness.ctx, log: harness.log });

      expect(harness.reads[0]?.where).toStrictEqual([
        { column: "place_id", op: "gt", value: "p0" },
      ]);
    });
  });

  describe("zero egress, structurally", () => {
    const sourcePath = path.join(import.meta.dirname, "place-names.js");
    const bundlePath = path.join(
      import.meta.dirname,
      "../../blueprints/automations/place-names/automations/place-names/handler.js"
    );

    // Prose in the handler header promises this; these two assertions are what
    // make the promise checkable. A gazetteer that quietly grew a geocoding
    // fallback would be the single worst regression this app could ship, and it
    // would look like a bug fix in review.
    it.each([
      ["source", sourcePath],
      ["bundle", bundlePath],
    ])("the %s reaches no network", async (_label, file) => {
      const text = await readFile(file, "utf8");
      // `ctx.fetch` is the only egress rail an automation is given, and the
      // matches below are CALLS, not the words: the handler's header says
      // "no `ctx.fetch`" in prose, and prose is not what this test is about.
      expect(text).not.toMatch(/\.fetch\s*\(/u);
      expect(text).not.toMatch(/(?:^|[^.\w])fetch\s*\(/u);
      expect(text).not.toMatch(/\.delegate\s*\(/u);
      expect(text).not.toMatch(/\bXMLHttpRequest\b/u);
      expect(text).not.toMatch(/\bnode:(?:https?|net|dgram|tls)\b/u);
      expect(text).not.toMatch(/https?:\/{2}/u);
    });

    it("does not touch the filesystem either — the table is compiled in", async () => {
      const text = await readFile(bundlePath, "utf8");
      expect(text).not.toMatch(/\bnode:fs\b/u);
      expect(text).not.toMatch(/readFileSync?\b/u);
    });

    it("was never offered a fetch to call", async () => {
      const harness = createHarness({
        entities: { "core.place": [place("p1", TRUCKEE_RIVER)] },
      });

      await handler({ ctx: harness.ctx, log: harness.log });

      expect(harness.fetches).toStrictEqual([]);
      expect(harness.delegateCalls).toStrictEqual([]);
      expect(harness.contentRequests).toStrictEqual([]);
    });
  });
});
