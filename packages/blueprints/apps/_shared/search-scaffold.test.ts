// The pure half of the search scaffold (issue #712 S1): grouping caps,
// status derivation, and the copy builders every app's search surface
// shares. Pure-function assertions, same convention `write-target.test.ts`
// and `placement-registry.test.ts` use for other `_shared` modules — no
// rendering here, `SearchScaffold.test.tsx` covers the component.
import { describe, expect, it } from "vitest";

import {
  deriveSearchStatus,
  groupSearchHits,
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
