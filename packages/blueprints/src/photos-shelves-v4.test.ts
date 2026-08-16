// @vitest-environment jsdom
// The four v4 shelves that used to lead nowhere, plus the routing that reaches
// them (v4 handoff §5, §9, §12, §13).
//
// Places, People, Storage and the permission screen are the last of the app's
// advertised destinations to land, and each one is asserted on the thing that
// makes it honest rather than on its markup:
//
//   Places   groups by the place a photograph CARRIES; a photograph with no
//            place is not "somewhere unknown" and must not appear at all.
//   People   the roster is the member's confirmed names, and a card crops the
//            first photograph of theirs this device actually loaded.
//   Storage  every number is read off the rows; a row with no recorded size is
//            counted and named rather than folded into a total that would then
//            be presented as the truth.
//   More     the band's sixth slot carries exactly what the five destinations
//            left behind, plus Storage — never a destination that is already a
//            tab, which would be one place in two.
//
// Rendered to static markup where a view is asserted: these are pure views over
// their props, so the markup IS the behaviour, and a server render keeps the
// assertions free of act() scheduling noise. The app sources are loaded by file
// URL, like every other blueprint-app fixture here.
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createElement } from "react";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const app = (rel: string): string =>
  pathToFileURL(path.resolve(import.meta.dirname, "../apps/photos", rel)).href;

interface Asset {
  asset_id: string;
  place?: { place_id: string; name: string } | null;
  byte_size?: number | null;
  custody_state?: string | null;
}
interface PlaceSection {
  key: string;
  name: string | null;
  assets: Asset[];
}
interface Person {
  party_id: string;
  name: string | null;
  count: number;
  asset_ids: string[];
}
interface Shelf {
  id: string | null;
  label: string;
  segment: string;
}

const { placeSections } = (await import(app("components/Places.tsx"))) as {
  placeSections: (assets: readonly Asset[]) => PlaceSection[];
};
const { coverFor, PeopleShelf } = (await import(
  app("components/People.tsx")
)) as {
  coverFor: (person: Person, assets: readonly Asset[]) => Asset | undefined;
  PeopleShelf: ComponentType<{
    people: readonly Person[];
    assets: readonly Asset[];
    onOpen: (partyId: string) => void;
  }>;
};
const { storageFacts, StorageView } = (await import(
  app("components/Storage.tsx")
)) as {
  storageFacts: (
    assets: readonly Asset[],
    trash: readonly Asset[],
    truncated: boolean
  ) => {
    shown: number;
    truncated: boolean;
    bytes: number;
    unsized: number;
    trashCount: number;
    trashBytes: number;
  };
  StorageView: ComponentType<{
    facts: ReturnType<
      (
        assets: readonly Asset[],
        trash: readonly Asset[],
        truncated: boolean
      ) => never
    >;
    custody: unknown;
    onOpenTrash: () => void;
  }>;
};
// The whole-library custody rollup the screen reads (issue #711). Its own
// arithmetic is covered by apps/photos/storage-model.test.ts; here it is a
// prop, and the UNCOUNTED case is the one this file cares about — a Storage
// screen with no rollup must still render its window facts.
const { custodyFacts } = (await import(app("storage-model.ts"))) as {
  custodyFacts: (
    scopes: readonly { label: string; rollup: unknown }[]
  ) => unknown;
};
/** Every bucket at zero — a fixture spreads the ones it means over this. */
const ZERO_BUCKETS = {
  "pending-offsite": { count: 0, bytes: 0 },
  "local-only": { count: 0, bytes: 0 },
  replicated: { count: 0, bytes: 0 },
  "remote-only": { count: 0, bytes: 0 },
  missing: { count: 0, bytes: 0 },
  freeable: { count: 0, bytes: 0 },
  "local-unproven": { count: 0, bytes: 0 },
};
/** No scope has answered — the state every pre-existing assertion here runs in. */
const NO_ROLLUP = custodyFacts([{ label: "Library", rollup: null }]);
const { PermissionScreen } = (await import(
  app("components/Permission.tsx")
)) as {
  PermissionScreen: ComponentType<{ reason?: string | null }>;
};
const {
  MORE_DESTINATIONS,
  BAND_DESTINATIONS,
  STORAGE,
  allowsSelection,
  packsTiles,
  personIdFrom,
  personShelf,
  shelfFromRoute,
  shelfRoute,
  showsTimeline,
} = (await import(app("shelves.ts"))) as {
  MORE_DESTINATIONS: readonly Shelf[];
  BAND_DESTINATIONS: readonly { id: string; label: string }[];
  STORAGE: string;
  allowsSelection: (id: string | null) => boolean;
  packsTiles: (id: string | null) => boolean;
  personIdFrom: (id: string | null) => string | null;
  personShelf: (partyId: string) => string;
  shelfFromRoute: (route: string) => string | null;
  shelfRoute: (id: string | null) => string;
  showsTimeline: (id: string | null) => boolean;
};

const placed = (id: string, placeId: string, name: string): Asset => ({
  asset_id: id,
  place: { place_id: placeId, name },
});

describe("Places groups by the place a photograph carries", () => {
  it("puts every photograph of one place in one section, in order", () => {
    const sections = placeSections([
      placed("a", "p1", "Lyme Regis"),
      placed("b", "p2", "Bristol"),
      placed("c", "p1", "Lyme Regis"),
    ]);
    expect(sections.map((s) => s.name)).toStrictEqual([
      "Lyme Regis",
      "Bristol",
    ]);
    expect(sections[0]!.assets.map((a) => a.asset_id)).toStrictEqual([
      "a",
      "c",
    ]);
  });

  it("leaves a photograph with no place out entirely", () => {
    // Not "somewhere unknown": nobody told the vault where this was taken, and
    // a section for it would be a claim about geography.
    expect(
      placeSections([{ asset_id: "a" }, { asset_id: "b", place: null }])
    ).toStrictEqual([]);
  });

  it("groups a place that has no name under an honest section", () => {
    const [section] = placeSections([
      { asset_id: "a", place: { place_id: "p1", name: "" } },
    ]);
    expect(section!.name).toBeNull();
  });

  it("packs tiles and takes a selection, like every timeline shelf", () => {
    const PLACES = shelfFromRoute("photos/places");
    expect(showsTimeline(PLACES)).toBe(false); // not the month scroller
    expect(packsTiles(PLACES)).toBe(true);
    expect(allowsSelection(PLACES)).toBe(true);
  });
});

describe("People shows confirmed names and crops what is loaded", () => {
  const ana: Person = {
    party_id: "party-1",
    name: "Ana",
    count: 2,
    asset_ids: ["a", "z"],
  };

  it("crops the first photograph of theirs this device has loaded", () => {
    expect(
      coverFor(ana, [{ asset_id: "q" }, { asset_id: "z" }])?.asset_id
    ).toBe("z");
  });

  it("has no cover at all when none of theirs is loaded", () => {
    // The card keeps its square and says nothing it cannot show.
    expect(coverFor(ana, [{ asset_id: "q" }])).toBeUndefined();
  });

  it("names the count and says what it does NOT show", () => {
    const html = renderToStaticMarkup(
      createElement(PeopleShelf, {
        people: [ana],
        assets: [],
        onOpen: () => {},
      })
    );
    expect(html).toContain("Ana");
    expect(html).toContain(">2<");
    // Unconfirmed faces stay in the enrichment flow — the shelf says so rather
    // than duplicating that loop. The live count has not loaded under a
    // static-markup render (no effect has fired), so the note omits the
    // number rather than claiming a zero nobody checked (photos-people.test.ts
    // covers the loaded-count case with a client render).
    expect(html).toContain("not matched to anyone yet");
  });

  it("routes one person as a sub-state of the shelf, not as an album", () => {
    const id = personShelf("party-1");
    expect(personIdFrom(id)).toBe("party-1");
    expect(personIdFrom("built-in:people")).toBeNull();
    // An album id carries no colon, so it can never be read as a person.
    expect(personIdFrom("col_abc")).toBeNull();
    // And one person's own view IS the timeline under a filter.
    expect(showsTimeline(id)).toBe(true);
  });
});

describe("Storage reports what the rows say and nothing else", () => {
  const rows: Asset[] = [
    { asset_id: "a", byte_size: 1000, custody_state: "replicated" },
    { asset_id: "b", byte_size: 2000, custody_state: "local-only" },
    { asset_id: "c", custody_state: "replicated" },
  ];

  it("counts unsized rows instead of folding them into the total", () => {
    const facts = storageFacts(rows, [], false);
    expect(facts.bytes).toBe(3000);
    expect(facts.unsized).toBe(1);
    expect(facts.shown).toBe(3);
  });

  it("says nothing about custody when the sweep has not answered", () => {
    // Custody is no longer inferred from the loaded rows at all (issue #711):
    // the whole-library rollup replaced that window-sized answer. With no
    // rollup the screen says so, and prints no custody section.
    const facts = storageFacts([{ asset_id: "a", byte_size: 1 }], [], false);
    const html = renderToStaticMarkup(
      createElement(StorageView, {
        facts: facts as never,
        custody: NO_ROLLUP,
        onOpenTrash: () => {},
      })
    );
    expect(html).toContain("will not guess");
    expect(html).not.toContain("Where the originals are");
    expect(html).not.toContain("Free up space");
  });

  it("prints the whole library's custody once the gateway has counted it", () => {
    const html = renderToStaticMarkup(
      createElement(StorageView, {
        facts: storageFacts(rows, [], true) as never,
        custody: custodyFacts([
          {
            label: "Library",
            rollup: {
              computedAt: "2026-08-04T09:00:00.000Z",
              buckets: {
                ...ZERO_BUCKETS,
                replicated: { count: 1412, bytes: 96_400_000_000 },
                "remote-only": { count: 186, bytes: 6_000_000_000 },
              },
            },
          },
        ]),
        onOpenTrash: () => {},
      })
    );
    // The rollup's counts, not the three loaded rows'.
    expect(html).toContain("Where the originals are");
    expect(html).toContain("1412");
    expect(html).toContain("186");
    // …and the window's own numbers are still labelled as the window.
    expect(html).toContain("loaded here");
  });

  it("offers to release ONLY bytes proved to be held elsewhere", () => {
    const html = renderToStaticMarkup(
      createElement(StorageView, {
        facts: storageFacts(rows, [], false) as never,
        custody: custodyFacts([
          {
            label: "Library",
            rollup: {
              computedAt: "2026-08-04T09:00:00.000Z",
              buckets: {
                ...ZERO_BUCKETS,
                "local-only": { count: 4000, bytes: 96_000_000_000 },
                // Everything on the disk is unproven: no offer, at any size.
                "local-unproven": { count: 4000, bytes: 96_000_000_000 },
              },
            },
          },
        ]),
        onOpenTrash: () => {},
      })
    );
    // The offer is the `.claim` paragraph; its absence is the assertion. (A
    // bare "could be released" substring would also match the REFUSAL below.)
    expect(html).not.toMatch(/class="[^"]*claim/u);
    expect(html).toContain("nothing that could be released");
    expect(html).toContain("never offered for release");
  });

  it("names the window when the library is truncated", () => {
    const html = renderToStaticMarkup(
      createElement(StorageView, {
        facts: storageFacts(rows, [], true) as never,
        custody: NO_ROLLUP,
        onOpenTrash: () => {},
      })
    );
    expect(html).toContain("loaded here");
    expect(html).not.toContain("your whole library.");
  });

  it("offers the one action that frees bytes, and only when there is any", () => {
    const empty = renderToStaticMarkup(
      createElement(StorageView, {
        facts: storageFacts(rows, [], false) as never,
        custody: NO_ROLLUP,
        onOpenTrash: () => {},
      })
    );
    expect(empty).not.toContain("Open the trash");
    const withTrash = renderToStaticMarkup(
      createElement(StorageView, {
        facts: storageFacts(
          rows,
          [{ asset_id: "t", byte_size: 9 }],
          false
        ).valueOf() as never,
        custody: NO_ROLLUP,
        onOpenTrash: () => {},
      })
    );
    expect(withTrash).toContain("Open the trash");
  });

  it("is a destination with a route, and never a ninth tab", () => {
    expect(shelfRoute(STORAGE)).toBe("photos/storage");
    expect(shelfFromRoute("photos/storage")).toBe(STORAGE);
    expect(MORE_DESTINATIONS.some((d) => d.id === STORAGE)).toBe(true);
  });
});

describe("the band's sixth slot carries what the five left behind", () => {
  it("never repeats a destination the band already has", () => {
    const bandIds = new Set(BAND_DESTINATIONS.map((d) => d.id));
    for (const destination of MORE_DESTINATIONS) {
      expect(bandIds.has(destination.segment)).toBe(false);
    }
  });

  it("carries the shelves off the band, in the strip's order, plus Storage", () => {
    expect(MORE_DESTINATIONS.map((d) => d.label)).toStrictEqual([
      "Favorites",
      "Places",
      "Duplicates",
      "Trash",
      "Storage",
    ]);
  });
});

describe("permission is a screen, not an error", () => {
  it("keeps the focus-refresh contract the element layer reads", () => {
    // `#consentBanner` is how `onFocusRefresh` knows a window focus is a
    // recovery from a just-granted permission. The element was redrawn; the
    // hook's question did not change.
    const html = renderToStaticMarkup(
      createElement(PermissionScreen, { reason: null })
    );
    expect(html).toContain('id="consentBanner"');
    expect(html).toContain('id="consentDetail"');
  });

  it("states what is missing in the host's own words when it gave any", () => {
    const html = renderToStaticMarkup(
      createElement(PermissionScreen, {
        reason: "media.asset read was not granted",
      })
    );
    expect(html).toContain("media.asset read was not granted");
  });

  it("says what Photos can see meanwhile, and what a returning grant does", () => {
    const html = renderToStaticMarkup(
      createElement(PermissionScreen, { reason: null })
    );
    expect(html).toContain("nothing");
    expect(html).toContain("exactly as it was");
    // A refused grant is a state, not a fault: nothing here is a fill.
    expect(html).not.toContain("kit-btn primary");
  });
});

// ---------------------------------------------------------------------------
// Search's four states (§9), the status line's determinate meter (§14), and
// the one member preference the duplicates shelf used to opt out of (§4.2).
// ---------------------------------------------------------------------------

interface SearchProps {
  query: string;
  status: "resting" | "searching" | "ready" | "unreachable";
  count: number;
  onQuery: (value: string) => void;
  onClear: () => void;
  children?: unknown;
}
interface Cluster {
  key: string;
  assets: { asset_id: string; width: number; height: number }[];
}

const { SearchShelf } = (await import(app("components/SearchShelf.tsx"))) as {
  SearchShelf: ComponentType<SearchProps>;
};
const { DuplicatesView } = (await import(app("components/Duplicates.tsx"))) as {
  DuplicatesView: ComponentType<{
    clusters: Cluster[] | null;
    loading: boolean;
    rung?: number;
    selected: Set<string>;
    onToggle: (assetId: string) => void;
    onTrashSelected: () => void;
  }>;
};
const { notice, setStatusSink } = (await import(app("outcomes.ts"))) as {
  notice: (
    text: string,
    undo?: () => void,
    progress?: { done: number; total: number }
  ) => void;
  setStatusSink: (
    fn:
      | ((
          note: {
            text: string;
            undo?: () => void;
            progress?: { done: number; total: number };
          } | null
        ) => void)
      | null
  ) => void;
};

const search = (props: Partial<SearchProps>): string =>
  renderToStaticMarkup(
    createElement(SearchShelf, {
      query: "",
      status: "resting",
      count: 0,
      onQuery: () => {},
      onClear: () => {},
      ...props,
    })
  );

describe("search is four states, and each one is a different sentence", () => {
  it("rests on five real example queries a member can type back", () => {
    const html = search({});
    expect(html).toContain("ana at the coast");
    expect(html).toContain("photographs with no place");
    expect(html).not.toContain("No matches");
  });

  it("is determinate while searching, and never a spinner", () => {
    const html = search({ query: "ana", status: "searching", count: 3 });
    expect(html).toContain("Searching your whole library");
    expect(html).toContain(">3<");
    expect(html).not.toContain("spinner");
  });

  it("echoes the query and what was searched on a miss", () => {
    const html = search({ query: "ferry", status: "ready", count: 0 });
    expect(html).toContain("Nothing matches “ferry”");
    // Aligned with mobile's wording for the same fact (issue #711
    // reconciliation) — see view-copy.ts's SEARCH_COPY.miss.body comment.
    expect(html).toContain(
      "Nothing in captions, people, places, things or album names."
    );
    expect(html).toContain("Clear the query");
  });

  it("will not pretend to have looked when the index is unreachable", () => {
    const html = search({ query: "ana", status: "unreachable", count: 2 });
    expect(html).toContain("Search needs the gateway");
    expect(html).toContain("Retry");
    expect(html).toContain("browsing, albums, favorites, captions");
    // The vault noun is forbidden in Photos copy (issue #599) — this is the
    // handoff's "Cannot reach the vault" without the word.
    expect(html).not.toContain("vault");
    // The honest miss line is a claim nobody verified here, so it is absent.
    expect(html).not.toContain("Nothing matches");
  });

  it("drops the resting panel the moment there is a query", () => {
    expect(search({ query: "ana", status: "ready", count: 1 })).not.toContain(
      "ana at the coast"
    );
  });
});

describe("the status line carries determinate progress", () => {
  it("passes exact counts through, and omits the meter without them", () => {
    const seen: unknown[] = [];
    setStatusSink((note) => seen.push(note));
    notice("Importing", undefined, { done: 148, total: 214 });
    notice("Done");
    setStatusSink(null);
    expect(seen[0]).toStrictEqual({
      text: "Importing",
      progress: { done: 148, total: 214 },
    });
    expect(seen[1]).toStrictEqual({ text: "Done" });
  });
});

describe("the duplicates shelf honours the member's tile size", () => {
  const cluster: Cluster = {
    key: "c1",
    assets: [
      { asset_id: "a", width: 100, height: 100 },
      { asset_id: "b", width: 100, height: 100 },
    ],
  };
  const render = (rung?: number): string =>
    renderToStaticMarkup(
      createElement(DuplicatesView, {
        clusters: [cluster],
        loading: false,
        ...(rung === undefined ? {} : { rung }),
        selected: new Set<string>(),
        onToggle: () => {},
        onTrashSelected: () => {},
      })
    );

  it("packs at the rung it is given, not at a size of its own", () => {
    // A shelf pinned to one rung would be a fifth, surface-specific tile size
    // the member never chose (§4.2).
    expect(render(0)).not.toBe(render(3));
  });

  it("falls back to S for a caller with no preference to give", () => {
    expect(render()).toBe(render(1));
  });
});
