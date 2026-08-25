// The pure half of the search scaffold (#712): grouping caps,
// status derivation, and the copy builders every app's search surface
// shares. Pure-function assertions, same convention `write-target.test.ts`
// and `placement-registry.test.ts` use for other `_shared` modules — no
// rendering here, `SearchScaffold.test.tsx` covers the component.
import { describe, expect, it } from "vitest";

import {
  deriveSearchStatus,
  groupSearchHits,
  perScopeReach,
  scopeReachFacts,
  searchOpenLabel,
  searchStatusLine,
} from "./search-scaffold.ts";
import type { SearchEntity, SearchGroupRow } from "./search-scaffold.ts";

interface Source {
  people: readonly string[];
  places: readonly string[];
}

function entity(
  key: string,
  pick: (source: Source) => readonly string[]
): SearchEntity<Source, SearchGroupRow> {
  return {
    key,
    label: key,
    match: (term, source) =>
      pick(source)
        .filter((name) => name.toLowerCase().includes(term))
        .map((name) => ({
          kind: key,
          key: name,
          title: name,
          meta: `${key} · matched`,
          openTarget: name,
        })),
  };
}

const PERSON = entity("person", (s) => s.people);
const PLACE = entity("place", (s) => s.places);
const ENTITIES: readonly SearchEntity<Source, SearchGroupRow>[] = [
  PERSON,
  PLACE,
];

describe(groupSearchHits, () => {
  // [law:search-scaffold-grouping] Configured entities own grouping and caps.
  it("is empty for an empty or whitespace-only query — resting has no hits to group", () => {
    const source: Source = { people: ["Ana"], places: ["Lyme"] };
    expect(groupSearchHits("", source, ENTITIES)).toStrictEqual([]);
    expect(groupSearchHits("   ", source, ENTITIES)).toStrictEqual([]);
  });

  it("runs every configured entity in the order the config declares, never a switch on which one it is", () => {
    const source: Source = {
      people: ["Ana Ferris"],
      places: ["Lyme Regis"],
    };
    const hits = groupSearchHits("i", source, ENTITIES);
    expect(hits.map((h) => h.kind)).toStrictEqual(["person", "place"]);
  });

  it("caps each entity independently at maxPerGroup, not the flattened total", () => {
    const source: Source = {
      people: ["Ana", "Ana-Marie", "Anabel", "Anaïs"],
      places: [],
    };
    const hits = groupSearchHits("ana", source, ENTITIES, 2);
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.kind === "person")).toBe(true);
  });

  it("never invents a hit for an entity whose find returns nothing", () => {
    const source: Source = { people: [], places: [] };
    expect(groupSearchHits("anything", source, ENTITIES)).toStrictEqual([]);
  });

  it("lower-cases and trims the term before handing it to find", () => {
    const source: Source = { people: ["Ana"], places: [] };
    const hits = groupSearchHits("  ANA  ", source, ENTITIES);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.title).toBe("Ana");
  });

  it("a config with a different order changes the output order — the scaffold has no order of its own", () => {
    const source: Source = { people: ["Ana"], places: ["Anaheim"] };
    const reordered = groupSearchHits("ana", source, [PLACE, PERSON]);
    expect(reordered.map((h) => h.kind)).toStrictEqual(["place", "person"]);
  });
});

describe(deriveSearchStatus, () => {
  it("is resting for an empty (or whitespace-only) query regardless of the fetch facts", () => {
    expect(
      deriveSearchStatus({ query: "", inFlight: true, reached: false })
    ).toBe("resting");
    expect(
      deriveSearchStatus({ query: "  ", inFlight: false, reached: true })
    ).toBe("resting");
  });

  it("is searching while a query is typed and the fetch has not answered", () => {
    expect(
      deriveSearchStatus({ query: "ana", inFlight: true, reached: false })
    ).toBe("searching");
  });

  it("is ready once the fetch answers, whatever it answered", () => {
    expect(
      deriveSearchStatus({ query: "ana", inFlight: false, reached: true })
    ).toBe("ready");
  });

  it("is unreachable when the fetch could not be reached — never collapsed into ready", () => {
    expect(
      deriveSearchStatus({ query: "ana", inFlight: false, reached: false })
    ).toBe("unreachable");
  });
});

describe(searchStatusLine, () => {
  it("pluralises the count and states the caller's own scope verbatim", () => {
    expect(searchStatusLine(0, "the live library")).toBe(
      "0 results · searched the live library"
    );
    expect(searchStatusLine(1, "the live library")).toBe(
      "1 result · searched the live library"
    );
    expect(searchStatusLine(2, "the whole replica on this device")).toBe(
      "2 results · searched the whole replica on this device"
    );
  });
});

describe(searchOpenLabel, () => {
  it("announces the row's own title", () => {
    expect(searchOpenLabel({ title: "Ana" })).toBe("Open Ana");
  });
});

describe(perScopeReach, () => {
  // [law:per-scope-reach] #726 P4 item 7 (D11): reach is named per scope,
  // never collapsed into one boolean before a caller can render which scope
  // is short.
  it("names each scope's own state instead of one shared boolean", () => {
    expect(
      perScopeReach([
        { scope: "photos-own", ok: true },
        {
          scope: "photos-commons",
          ok: false,
          error: { message: "peer offline" },
        },
      ])
    ).toStrictEqual([
      { scope: "photos-own", state: "reached" },
      { scope: "photos-commons", state: "unreached", detail: "peer offline" },
    ]);
  });

  it("omits detail for an unreached scope with no error message", () => {
    expect(
      perScopeReach([{ scope: "photos-commons", ok: false }])
    ).toStrictEqual([{ scope: "photos-commons", state: "unreached" }]);
  });

  // [law:mask-refuses-not-no-matches] #726 P4 D10: a scope whose field mask
  // excludes an indexed column REFUSES — it never pretends a narrower index
  // was the whole one, and refused beats unreached when a caller knows both.
  it("marks a scope REFUSED when it is named in refusedScopes, even if it also answered ok", () => {
    const reach = perScopeReach(
      [{ scope: "photos-commons", ok: true }],
      new Map([
        ["photos-commons", "field mask excludes core.content_item.title"],
      ])
    );
    expect(reach).toStrictEqual([
      {
        scope: "photos-commons",
        state: "refused",
        detail: "field mask excludes core.content_item.title",
      },
    ]);
  });

  it("prefers the refusal reason over an unreached scope's transport error", () => {
    const reach = perScopeReach(
      [{ scope: "photos-commons", ok: false, error: { message: "timeout" } }],
      new Map([
        ["photos-commons", "field mask excludes core.content_item.title"],
      ])
    );
    expect(reach[0]!.state).toBe("refused");
    expect(reach[0]!.detail).toBe(
      "field mask excludes core.content_item.title"
    );
  });

  it("propagates a replica mask refusal directly from readAll", () => {
    expect(
      perScopeReach([
        {
          scope: "photos-commons",
          ok: false,
          error: {
            code: "REPLICA_SEARCH_REFUSED",
            message:
              "Search refused in this scope: title is withheld by the scope mask",
          },
        },
      ])
    ).toStrictEqual([
      {
        scope: "photos-commons",
        state: "refused",
        detail:
          "Search refused in this scope: title is withheld by the scope mask",
      },
    ]);
  });
});

describe(scopeReachFacts, () => {
  it("lists only the short scopes, each with a value naming why", () => {
    expect(
      scopeReachFacts([
        { scope: "photos-own", state: "reached" },
        { scope: "photos-commons", state: "unreached", detail: "peer offline" },
        {
          scope: "photos-shared",
          state: "refused",
          detail: "field mask excludes title",
        },
      ])
    ).toStrictEqual([
      { label: "photos-commons", value: "peer offline" },
      { label: "photos-shared", value: "field mask excludes title" },
    ]);
  });

  it("falls back to a generic value when no detail was given", () => {
    expect(
      scopeReachFacts([{ scope: "photos-commons", state: "unreached" }])
    ).toStrictEqual([
      { label: "photos-commons", value: "could not be reached" },
    ]);
  });

  it("is empty when every scope reached", () => {
    expect(
      scopeReachFacts([{ scope: "photos-own", state: "reached" }])
    ).toStrictEqual([]);
  });
});
