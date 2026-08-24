// The People shelf's model (#724). Each case is a claim the shelf
// makes to a member: who is named, what is only a question, what a group is,
// and what the shelf says when it holds nothing.

import { describe, expect, it } from "vitest";

import {
  PEOPLE_EMPTY,
  PEOPLE_PENDING_EMPTY,
  buildPeopleShelf,
  detectFacesFor,
  detectFacesIntent,
  nameGroupIntents,
} from "./people-model";
import type {
  FaceClusterRow,
  FaceRegionRow,
  PartyRow,
  PeopleFacts,
} from "./people-model";

function region(
  over: Partial<FaceRegionRow> & { region_id: string }
): FaceRegionRow {
  return {
    asset_id: `asset-${over.region_id}`,
    bbox_json: '{"x":0.1,"y":0.2,"w":0.3,"h":0.4}',
    party_id: null,
    confirmed_by_party_id: null,
    review_state: "proposed",
    ...over,
  };
}

function facts(over: Partial<PeopleFacts> = {}): PeopleFacts {
  return {
    clusters: [],
    faces: [],
    parties: [],
    policies: [{ domain: "photos", tier: "gateway" }],
    ...over,
  };
}

const ANA: PartyRow = {
  party_id: "party-ana",
  kind: "person",
  display_name: "Ana",
};

describe("the People shelf's model", () => {
  it("names only the people the member confirmed, and counts photographs rather than faces", () => {
    const shelf = buildPeopleShelf(
      facts({
        parties: [ANA],
        faces: [
          // Two faces of Ana in ONE photograph — one photograph.
          region({
            region_id: "r-1",
            asset_id: "asset-a",
            review_state: "confirmed",
            party_id: ANA.party_id,
            confirmed_by_party_id: "owner",
          }),
          region({
            region_id: "r-2",
            asset_id: "asset-a",
            review_state: "confirmed",
            party_id: ANA.party_id,
            confirmed_by_party_id: "owner",
          }),
          region({
            region_id: "r-3",
            asset_id: "asset-b",
            review_state: "confirmed",
            party_id: ANA.party_id,
            confirmed_by_party_id: "owner",
          }),
        ],
      })
    );
    expect(shelf.people).toStrictEqual([
      {
        partyId: ANA.party_id,
        name: "Ana",
        count: 2,
        cover: {
          assetId: "asset-a",
          regionId: "r-1",
          bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
        },
      },
    ]);
  });

  it("keeps a candidate out of the named roster — a proposal is a question, and carries no name", () => {
    const shelf = buildPeopleShelf(
      facts({
        parties: [ANA],
        faces: [
          region({
            region_id: "r-guess",
            asset_id: "asset-c",
            review_state: "proposed",
            party_id: ANA.party_id,
          }),
        ],
      })
    );
    expect(shelf.people).toStrictEqual([]);
    expect(shelf.pendingByParty).toStrictEqual([
      {
        partyId: ANA.party_id,
        count: 1,
        cover: {
          assetId: "asset-c",
          regionId: "r-guess",
          bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
        },
      },
    ]);
    // The type has no name field at all, so a view cannot render one by
    // accident — this asserts the shape as well as the value.
    expect(shelf.pendingByParty[0]).not.toHaveProperty("name");
    expect(shelf.pendingTotal).toBe(1);
  });

  it("offers an unnamed group as one nameable thing, with every region in it", () => {
    const clusters: FaceClusterRow[] = [
      { region_id: "r-a", cluster_id: "r-a" },
      { region_id: "r-b", cluster_id: "r-a" },
      { region_id: "r-c", cluster_id: "r-a" },
    ];
    const shelf = buildPeopleShelf(
      facts({
        clusters,
        faces: [
          region({ region_id: "r-a", asset_id: "asset-1" }),
          region({ region_id: "r-b", asset_id: "asset-2" }),
          region({ region_id: "r-c", asset_id: "asset-2" }),
        ],
      })
    );
    expect(shelf.unnamed).toStrictEqual([
      {
        clusterId: "r-a",
        count: 2,
        regionIds: ["r-a", "r-b", "r-c"],
        cover: {
          assetId: "asset-1",
          regionId: "r-a",
          bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
        },
      },
    ]);
  });

  it("drops a group whose faces have been answered rather than showing a card that opens nothing", () => {
    const shelf = buildPeopleShelf(
      facts({
        clusters: [
          { region_id: "r-a", cluster_id: "r-a" },
          { region_id: "r-b", cluster_id: "r-a" },
        ],
        faces: [
          region({ region_id: "r-a", review_state: "rejected" }),
          region({ region_id: "r-b", review_state: "dismissed" }),
        ],
      })
    );
    expect(shelf.unnamed).toStrictEqual([]);
    expect(shelf.pendingTotal).toBe(0);
  });

  it("puts a matched candidate in the pending list, never in a stranger group", () => {
    const shelf = buildPeopleShelf(
      facts({
        parties: [ANA],
        clusters: [{ region_id: "r-matched", cluster_id: "r-matched" }],
        faces: [region({ region_id: "r-matched", party_id: ANA.party_id })],
      })
    );
    expect(shelf.unnamed).toStrictEqual([]);
    expect(shelf.pendingByParty.map((entry) => entry.partyId)).toStrictEqual([
      ANA.party_id,
    ]);
  });

  it("orders people and groups the same way every time", () => {
    const shelf = buildPeopleShelf(
      facts({
        parties: [
          ANA,
          { party_id: "party-zed", kind: "person", display_name: "Zed" },
        ],
        faces: [
          region({
            region_id: "r-z",
            asset_id: "asset-z",
            review_state: "confirmed",
            party_id: "party-zed",
            confirmed_by_party_id: "owner",
          }),
          region({
            region_id: "r-a",
            asset_id: "asset-a",
            review_state: "confirmed",
            party_id: ANA.party_id,
            confirmed_by_party_id: "owner",
          }),
          region({
            region_id: "r-n",
            asset_id: "asset-n",
            review_state: "confirmed",
            party_id: "party-nameless",
            confirmed_by_party_id: "owner",
          }),
        ],
      })
    );
    // Named people alphabetically, the unnamed party last — never dropped
    // (a member confirmed a face onto it, and hiding it would lose that).
    expect(shelf.people.map((entry) => entry.name)).toStrictEqual([
      "Ana",
      "Zed",
      null,
    ]);
  });

  it("says what would put somebody here, and that nothing runs on its own", () => {
    expect(buildPeopleShelf(facts()).empty).toBe(PEOPLE_EMPTY);
    // Once faces exist but none are named, the invitation would be a lie: the
    // member already asked. The sentence changes to say where the work is.
    expect(
      buildPeopleShelf(facts({ faces: [region({ region_id: "r-1" })] })).empty
    ).toBe(PEOPLE_PENDING_EMPTY);
  });

  it("offers Detect faces only at the rung that can actually answer it", () => {
    expect(detectFacesFor("gateway")).toStrictEqual({ available: true });
    // COMPAT: the pre-#712 name for the same rung stays legible.
    expect(detectFacesFor("model")).toStrictEqual({ available: true });
    // On-device enrichment is a real setting and a real refusal, with a reason
    // that names the road ("allow that in Privacy") rather than just failing.
    const device = detectFacesFor("device");
    expect(device.available).toBe(false);
    expect(device.reason).toContain("Privacy");
    const off = detectFacesFor("off");
    expect(off.available).toBe(false);
    expect(off.reason).toContain("Privacy");
  });

  it("says nothing at all while the policy is still being read", () => {
    // Not "unavailable because off" — that would be a claim the read has not
    // yet justified. No reason means the surface shows no refusal.
    expect(detectFacesFor(null)).toStrictEqual({ available: false });
    const shelf = buildPeopleShelf(facts({ policiesLoading: true }));
    expect(shelf.detectFaces).toStrictEqual({ available: false });
  });

  it("treats a library with no policy row as switched off, not as permitted", () => {
    expect(
      buildPeopleShelf(facts({ policies: [] })).detectFaces.available
    ).toBe(false);
  });

  it("asks for the whole library without naming the consent scope itself", () => {
    // `reason` and `capability` are pinned server-side. A client that could
    // send them could widen its own consent, so the intent carries neither.
    expect(detectFacesIntent()).toStrictEqual({
      action: "request-enrichment",
      input: { entity_type: "media.asset" },
    });
  });

  it("names a group as one answer per face, never one batch assertion", () => {
    expect(
      nameGroupIntents({ regionIds: ["r-a", "r-b"] }, "party-ana")
    ).toStrictEqual([
      {
        action: "answer-face",
        input: { region_id: "r-a", answer: "confirm", party_id: "party-ana" },
      },
      {
        action: "answer-face",
        input: { region_id: "r-b", answer: "confirm", party_id: "party-ana" },
      },
    ]);
  });
});
