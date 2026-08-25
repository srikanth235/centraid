// The view-model projection, asserted where it can lie: the roster shaping,
// the tri-state link facts, the overdue/Never arithmetic THROUGH the shared
// format module, the search scope, and the stored-hue round trip.

import { describe, expect, it } from "vitest";

import { isOverdue } from "@centraid/blueprints/apps/people/format";
import type { PersonRow } from "@centraid/blueprints/apps/people/types";

import {
  applyRosterFilter,
  avatarFill,
  projectDashboard,
  projectRoster,
  rosterSub,
  searchRoster,
  storedHueKey,
  storedHueValue,
} from "./people-model";
import { projectShareLinks } from "./people-share-model";

const DAY = 86_400_000;
const iso = (daysAgo: number): string =>
  new Date(Date.now() - daysAgo * DAY).toISOString();

function person(over: Partial<PersonRow>): PersonRow {
  return {
    party_id: "p1",
    name: "Ana",
    role: "",
    avatar_color: null,
    cadence_days: 0,
    last_contacted_at: null,
    created_at: iso(100),
    list_id: null,
    starred: false,
    reminders: [],
    ...over,
  };
}

describe("[law:people-overdue-never] cadence 0 is Never and never overdue", () => {
  it("keeps a zero-cadence person off every overdue surface", () => {
    const never = person({ cadence_days: 0, last_contacted_at: iso(400) });
    expect(isOverdue(never)).toBe(false);
    expect(applyRosterFilter([never], "due")).toStrictEqual([]);
    const dashboard = projectDashboard({
      people: [never],
      linksAvailable: true,
      activityLinks: [],
      activities: [],
      activityNotes: [],
      concepts: [],
    });
    expect(dashboard.reconnect).toStrictEqual([]);
    expect(dashboard.counts.reconnect).toBe(0);
  });

  it("marks a person overdue only after the cadence, not on the cadence day", () => {
    const due = person({ cadence_days: 30, last_contacted_at: iso(31) });
    const onCadence = person({ cadence_days: 30, last_contacted_at: iso(30) });
    const fresh = person({ cadence_days: 30, last_contacted_at: iso(29) });
    expect(isOverdue(due)).toBe(true);
    expect(isOverdue(onCadence)).toBe(false);
    expect(isOverdue(fresh)).toBe(false);
    expect(applyRosterFilter([due, onCadence, fresh], "due")).toHaveLength(1);
  });
});

describe("[law:people-link-tristate] the link fact is linked, unlinked or ABSENT", () => {
  const rosterRows = (bindings: Array<Record<string, unknown>> | null) =>
    projectRoster({
      profiles: [
        { party_id: "p1", created_at: iso(10), cadence_days: 0 },
        { party_id: "p2", created_at: iso(5), cadence_days: 0 },
      ],
      parties: [
        { party_id: "p1", display_name: "Ana" },
        { party_id: "p2", display_name: "Tom" },
      ],
      tags: [],
      concepts: [],
      schemes: [],
      dates: [],
      bindings,
    });

  it("answers true/false while the share read landed", () => {
    const roster = rosterRows([
      { binding_id: "b1", party_id: "p1", vault_id: "v1", linked_at: iso(3) },
    ]);
    expect(roster.linksAvailable).toBe(true);
    const ana = roster.people.find((row) => row.party_id === "p1");
    const tom = roster.people.find((row) => row.party_id === "p2");
    expect(ana?.linked).toBe(true);
    expect(ana?.vault_count).toBe(1);
    expect(tom?.linked).toBe(false);
    // Newest profile first — the query's own order.
    expect(roster.people[0]?.party_id).toBe("p2");
  });

  it("degrades to ABSENT — null, never a false unlinked — on denial", () => {
    const roster = rosterRows(null);
    expect(roster.linksAvailable).toBe(false);
    for (const row of roster.people) expect(row.linked).toBeNull();
    // Unknown answers NEITHER link chip.
    expect(applyRosterFilter(roster.people, "linked")).toStrictEqual([]);
    expect(applyRosterFilter(roster.people, "unlinked")).toStrictEqual([]);
  });

  it("nulls the whole person share answer when either table is unreadable", () => {
    expect(
      projectShareLinks({ partyId: "p1", bindings: [], invitations: null })
    ).toBeNull();
    expect(
      projectShareLinks({ partyId: "p1", bindings: null, invitations: [] })
    ).toBeNull();
  });
});

describe("[law:people-roster-sub] the vault leads a linked row's second line", () => {
  it("reads `Linked · role` linked, the role alone otherwise", () => {
    expect(rosterSub(person({ linked: true, role: "architect" }))).toBe(
      "Linked · architect"
    );
    expect(rosterSub(person({ linked: true }))).toBe("Linked");
    expect(rosterSub(person({ linked: false, role: "architect" }))).toBe(
      "architect"
    );
    expect(rosterSub(person({ role: "architect" }))).toBe("architect");
  });
});

describe("[law:people-trash-split] deleted profiles are the trash shelf, not roster rows", () => {
  it("splits on deleted_at and carries purge_at through", () => {
    const roster = projectRoster({
      profiles: [
        { party_id: "p1", created_at: iso(10), cadence_days: 0 },
        {
          party_id: "p2",
          created_at: iso(5),
          cadence_days: 0,
          deleted_at: iso(1),
          purge_at: iso(-29),
        },
      ],
      parties: [
        { party_id: "p1", display_name: "Ana" },
        { party_id: "p2", display_name: "Tom" },
      ],
      tags: [],
      concepts: [],
      schemes: [],
      dates: [],
      bindings: [],
    });
    expect(roster.people.map((row) => row.party_id)).toStrictEqual(["p1"]);
    expect(roster.trash).toHaveLength(1);
    expect(roster.trash[0]?.party_id).toBe("p2");
    expect(roster.trash[0]?.purge_at).not.toBeNull();
  });
});

describe("[law:people-search-scope] search covers name, role and notes", () => {
  const people = [
    person({ party_id: "p1", name: "Ana Whitcombe", role: "architect" }),
    person({ party_id: "p2", name: "Tom", role: "gardener" }),
  ];
  const notes = new Map([["p2", ["Met at the coast in June"]]]);

  it("matches case-insensitively across all three scopes", () => {
    expect(searchRoster(people, notes, "ana")).toHaveLength(1);
    expect(searchRoster(people, notes, "GARDEN")).toHaveLength(1);
    const byNote = searchRoster(people, notes, "coast");
    expect(byNote).toHaveLength(1);
    // The matched passage rides as the snippet.
    expect(byNote[0]?.snippet).toBe("Met at the coast in June");
  });

  it("answers nothing for a blank term", () => {
    expect(searchRoster(people, notes, "  ")).toStrictEqual([]);
  });
});

describe("[law:people-avatar-hue] the stored hue round-trips across surfaces", () => {
  it("parses only the wheel's own keys back out of a stored value", () => {
    expect(storedHueKey(storedHueValue("rose"))).toBe("rose");
    expect(storedHueKey("#8c4c61")).toBeNull();
    expect(storedHueKey(null)).toBeNull();
  });

  it("resolves a stored hue through the scheme, honours a hex verbatim, and derives from the id otherwise", () => {
    const ring = (key: string): string => `ring:${key}`;
    expect(
      avatarFill({ party_id: "p1", avatar_color: storedHueValue("teal") }, ring)
    ).toBe("ring:teal");
    expect(avatarFill({ party_id: "p1", avatar_color: "#8c4c61" }, ring)).toBe(
      "#8c4c61"
    );
    const derived = avatarFill({ party_id: "p1", avatar_color: null }, ring);
    expect(derived.startsWith("ring:")).toBe(true);
    // Keyed by the id, so a rename never moves them.
    expect(avatarFill({ party_id: "p1" }, ring)).toBe(derived);
  });
});
