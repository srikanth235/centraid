import { describe, expect, it } from "vitest";

import { buildQueue } from "./face-review-queue";

describe(buildQueue, () => {
  it("counts matches as OTHER regions proposing the same party, deduped by photograph (README.md:285 — never a percentage)", () => {
    const faces = [
      {
        region_id: "r1",
        asset_id: "a1",
        party_id: "p-ana",
        review_state: "proposed",
      },
      {
        region_id: "r2",
        asset_id: "a2",
        party_id: "p-ana",
        confirmed_by_party_id: "p-ana",
        review_state: "confirmed",
      },
      {
        region_id: "r3",
        asset_id: "a3",
        party_id: "p-ana",
        confirmed_by_party_id: "p-ana",
        review_state: "confirmed",
      },
      // A second region for "p-ana" on the SAME asset as r1 must not double
      // count that photograph.
      {
        region_id: "r4",
        asset_id: "a1",
        party_id: "p-ana",
        confirmed_by_party_id: "p-ana",
        review_state: "confirmed",
      },
    ];
    const queue = buildQueue(faces, []);
    expect(queue).toHaveLength(1); // only r1 is unconfirmed
    expect(queue[0]!.matchCount).toBe(2); // a2 and a3 — a1 is r1's own asset
  });

  it("excludes confirmed regions from the queue", () => {
    const faces = [
      {
        region_id: "r1",
        asset_id: "a1",
        party_id: "p1",
        confirmed_by_party_id: "p1",
        review_state: "confirmed",
      },
      {
        region_id: "r2",
        asset_id: "a2",
        party_id: null,
        review_state: "proposed",
      },
    ];
    const queue = buildQueue(faces, []);
    expect(queue.map((q) => q.regionId)).toStrictEqual(["r2"]);
  });

  it("a rejected or dismissed region never comes back to the queue (issue 712)", () => {
    // The whole point of `review_state`. Before it, a rejection deleted the
    // row and a "keep it, do not name it" could not be expressed at all — so
    // the only faces a member could get rid of were the ones they named.
    const faces = [
      {
        region_id: "r1",
        asset_id: "a1",
        party_id: null,
        review_state: "proposed",
      },
      {
        region_id: "r2",
        asset_id: "a2",
        party_id: null,
        review_state: "rejected",
      },
      {
        region_id: "r3",
        asset_id: "a3",
        party_id: null,
        review_state: "dismissed",
      },
    ];
    const queue = buildQueue(faces, []);
    expect(queue.map((q) => q.regionId)).toStrictEqual(["r1"]);
  });

  it("an unmatched region (no party_id) has a zero match count, not a crash", () => {
    const queue = buildQueue(
      [
        {
          region_id: "r1",
          asset_id: "a1",
          party_id: null,
          review_state: "proposed",
        },
      ],
      []
    );
    expect(queue[0]!.matchCount).toBe(0);
    expect(queue[0]!.partyId).toBeNull();
  });

  it("first seen is the earliest capture date among the matching photographs", () => {
    const faces = [
      {
        region_id: "r1",
        asset_id: "a1",
        party_id: "p1",
        review_state: "proposed",
      },
      {
        region_id: "r2",
        asset_id: "a2",
        party_id: "p1",
        confirmed_by_party_id: "p1",
        review_state: "confirmed",
      },
    ];
    const assets = [
      { asset_id: "a1", captured_at: "2026-06-12T00:00:00.000Z" },
      { asset_id: "a2", captured_at: "2020-01-01T00:00:00.000Z" },
    ];
    const queue = buildQueue(faces, assets);
    expect(queue[0]!.firstSeenAt).toBe("2020-01-01T00:00:00.000Z");
  });

  it("orders the queue deterministically by region_id", () => {
    const faces = [
      {
        region_id: "r3",
        asset_id: "a3",
        party_id: null,
        review_state: "proposed",
      },
      {
        region_id: "r1",
        asset_id: "a1",
        party_id: null,
        review_state: "proposed",
      },
      {
        region_id: "r2",
        asset_id: "a2",
        party_id: null,
        review_state: "proposed",
      },
    ];
    const queue = buildQueue(faces, []);
    expect(queue.map((q) => q.regionId)).toStrictEqual(["r1", "r2", "r3"]);
  });
});
