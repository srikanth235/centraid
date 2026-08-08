import { describe, expect, it } from "vitest";

import { groupPeopleFaces } from "./people-counts.ts";

describe("shared people counts", () => {
  it("[law:people-photograph-counts] counts confirmed photographs once and keeps proposals separate", () => {
    const groups = groupPeopleFaces(
      [
        {
          region_id: "r1",
          asset_id: "a1",
          party_id: "p1",
          review_state: "confirmed",
          confirmed_by_party_id: "owner",
        },
        {
          region_id: "r2",
          asset_id: "a1",
          party_id: "p1",
          review_state: "confirmed",
          confirmed_by_party_id: "owner",
        },
        {
          region_id: "r3",
          asset_id: "a2",
          party_id: "p1",
          review_state: "proposed",
        },
        { region_id: "r4", asset_id: "a3", review_state: "proposed" },
        { region_id: "r5", asset_id: "a4", review_state: "proposed" },
      ],
      [
        { region_id: "r4", cluster_id: "c1" },
        { region_id: "r5", cluster_id: "c1" },
      ]
    );
    expect(groups.confirmed[0]?.assetIds).toStrictEqual(["a1"]);
    expect(groups.pendingByParty[0]?.id).toBe("p1");
    expect(groups.unnamed[0]?.assetIds).toStrictEqual(["a3", "a4"]);
    expect(groups.pendingTotal).toBe(3);
  });
});
