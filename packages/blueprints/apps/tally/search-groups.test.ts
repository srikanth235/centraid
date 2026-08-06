// Tally's own entity config for the shared search scaffold (issue #712 S1,
// deliverable 2 — the second real consumer proving `groupSearchHits`
// generalises past Photos). Same style as Photos' own
// `search-groups.test.ts`: pure-function assertions against real-shaped
// dashboard data, no rendering.
import { describe, expect, it } from "vitest";

import { tallySearchGroups } from "./search-groups.ts";
import type { Friend, Group } from "./types.ts";

const TAHOE: Group = {
  group_id: "group-tahoe",
  name: "Tahoe Trip",
  member_count: 4,
  owner_net_minor: 0,
};
const MAYA: Friend = {
  party_id: "party-maya",
  name: "Maya",
  color: "steelblue",
  initials: "M",
  net_minor: 1200,
};
const JAKE: Friend = {
  party_id: "party-jake",
  name: "Jake",
  color: "coral",
  initials: "J",
  net_minor: -500,
};

describe(tallySearchGroups, () => {
  it("is empty for an empty or whitespace-only query", () => {
    expect(
      tallySearchGroups("", { groups: [TAHOE], friends: [MAYA] })
    ).toStrictEqual([]);
    expect(
      tallySearchGroups("   ", { groups: [TAHOE], friends: [MAYA] })
    ).toStrictEqual([]);
  });

  it("matches a group by name, case-insensitively, with its real member count", () => {
    const hits = tallySearchGroups("tahoe", {
      groups: [TAHOE],
      friends: [],
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      kind: "group",
      title: "Tahoe Trip",
      meta: "group · 4 members",
      openTarget: "group-tahoe",
    });
  });

  it("matches a friend by name and opens straight to their party id", () => {
    const hits = tallySearchGroups("may", {
      groups: [],
      friends: [MAYA, JAKE],
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      kind: "person",
      title: "Maya",
      openTarget: "party-maya",
    });
  });

  it("orders groups before people, the order the entity config declares", () => {
    const hits = tallySearchGroups("a", {
      groups: [TAHOE],
      friends: [MAYA, JAKE],
    });
    expect(hits.map((h) => h.kind)).toStrictEqual([
      "group",
      "person",
      "person",
    ]);
  });

  it("never fabricates a hit for a query nothing matches", () => {
    expect(
      tallySearchGroups("nobody-matches-this-query", {
        groups: [TAHOE],
        friends: [MAYA, JAKE],
      })
    ).toStrictEqual([]);
  });

  it("caps each entity at three, same as Photos' own groups", () => {
    const friends: Friend[] = Array.from({ length: 5 }, (_, i) => ({
      party_id: `party-ana-${i}`,
      name: `Ana ${i}`,
      color: "steelblue",
      initials: "A",
      net_minor: 0,
    }));
    const hits = tallySearchGroups("ana", { groups: [], friends });
    expect(hits).toHaveLength(3);
  });
});
