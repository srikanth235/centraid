import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { buildMemories } from "./memories.ts";
import type { Asset, Place } from "./types.ts";

describe("web memories", () => {
  it("renders only the library projection and resolves its ordered cover", () => {
    const onOpen = vi.fn<(shelf: string) => void>();
    const cards = buildMemories({
      ownAssets: [
        { asset_id: "favorite", favorite: 1, content_uri: "favorite.jpg" },
        { asset_id: "member", thumb_uri: "member.jpg" },
      ],
      memories: [
        {
          memory_id: "trip-1",
          kind: "trip",
          title_hint: "Three days in Mysuru",
          computed_at: "2026-08-07T00:00:00Z",
        },
      ],
      memoryMembers: [{ memory_id: "trip-1", asset_id: "member", ordinal: 0 }],
      onOpen,
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      key: "trip-1",
      // No member of this trip carries a place, so the ladder has nothing to
      // name and the vault's own hint still titles the card (#816).
      title: "Three days in Mysuru",
      coverUri: "member.jpg",
    });
    expect(cards[0]!.route).toBeUndefined();
    cards[0]!.onOpen();
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("memory:trip-1");
  });
});

// ── A trip card, titled and sketched (issue #816) ──────────────────────────
//
// `trips.test.ts` owns the title grammar and the route arithmetic. What these
// cases own is the wiring: that a trip card asks the ladder at all, that it
// resolves HOME from the whole library rather than from the trip (the mistake
// that makes every away day read as a day at home), and that no other kind of
// memory changed shape.

const HOME: Place = {
  place_id: "place-home",
  name: "Home",
  kind: "home",
  lat: 37.4419,
  lng: -122.143,
};

const TAHOE: Place = {
  place_id: "place-tahoe",
  // What `findOrCreatePlaceTx` mints, still unrenamed — the case the title
  // must never print.
  name: "39.09680, -120.03240",
  gazetteer: "South Lake Tahoe, CA",
  lat: 39.0968,
  lng: -120.0324,
};

const TRUCKEE: Place = {
  place_id: "place-truckee",
  name: "39.32800, -120.18330",
  gazetteer: "Truckee, CA",
  lat: 39.328,
  lng: -120.1833,
};

const frame = (
  asset_id: string,
  taken_at: string,
  place: Place | null
): Asset => ({
  asset_id,
  taken_at,
  place,
  thumb_uri: `${asset_id}.jpg`,
});

/** Six days at home, then a Saturday and a Sunday at the lake with a stop in
 *  Truckee on the way — the seeded roll's shape. */
const LIBRARY: Asset[] = [
  ...Array.from({ length: 6 }, (_, index) =>
    frame(`home-${index}`, `2026-08-0${index + 1}T12:00:00Z`, HOME)
  ),
  frame("truckee-1", "2026-08-15T09:00:00Z", TRUCKEE),
  frame("tahoe-1", "2026-08-15T14:00:00Z", TAHOE),
  frame("tahoe-2", "2026-08-16T11:00:00Z", TAHOE),
  frame("indoors", "2026-08-16T20:00:00Z", null),
];

const TRIP_MEMBERS = ["truckee-1", "tahoe-1", "tahoe-2", "indoors"].map(
  (asset_id, ordinal) => ({ memory_id: "trip:2026-08-15", asset_id, ordinal })
);

function tripCard(overrides: Record<string, unknown> = {}) {
  const cards = buildMemories({
    ownAssets: LIBRARY,
    memories: [
      {
        memory_id: "trip:2026-08-15",
        kind: "trip",
        title_hint: "2-day trip",
        place_id: TAHOE.place_id,
        started_at: "2026-08-15T09:00:00Z",
        ended_at: "2026-08-16T20:00:00Z",
        ...overrides,
      },
    ],
    memoryMembers: TRIP_MEMBERS,
    onOpen: () => undefined,
  });
  return cards[0]!;
}

describe("a trip card", () => {
  it("titles the trip through the phrase ladder instead of the day count", () => {
    expect(tripCard().title).toBe("Weekend in South Lake Tahoe, CA");
  });

  it("carries the trip's stops in capture order, ready to project", () => {
    // Truckee first because it was photographed first — the sketch draws a
    // route, and a route ordered by tally is not one.
    expect(tripCard().route).toStrictEqual([
      {
        key: TRUCKEE.place_id,
        lat: TRUCKEE.lat,
        lng: TRUCKEE.lng,
        count: 1,
        name: "Truckee, CA",
      },
      {
        key: TAHOE.place_id,
        lat: TAHOE.lat,
        lng: TAHOE.lng,
        count: 2,
        name: "South Lake Tahoe, CA",
      },
    ]);
  });

  it("prints neither a coordinate nor a bearing from home", () => {
    const card = tripCard();
    expect(card.title).not.toMatch(/\d\.\d/u);
    expect(card.title).not.toContain("Home");
    expect(card.sub).toBe("4 photographs");
  });

  it("counts the unlocated frame as a photograph and not as a stop", () => {
    const card = tripCard();
    expect(card.sub).toBe("4 photographs");
    expect(card.route).toHaveLength(2);
  });

  it("keeps the detector's hint when no member place has a printable name", () => {
    const cards = buildMemories({
      ownAssets: [
        frame("home-1", "2026-08-01T12:00:00Z", HOME),
        frame("away-1", "2026-08-15T12:00:00Z", { ...TAHOE, gazetteer: null }),
        frame("away-2", "2026-08-16T12:00:00Z", { ...TAHOE, gazetteer: null }),
      ],
      memories: [
        {
          memory_id: "trip:2026-08-15",
          kind: "trip",
          title_hint: "2-day trip",
          place_id: TAHOE.place_id,
        },
      ],
      memoryMembers: [
        { memory_id: "trip:2026-08-15", asset_id: "away-1", ordinal: 0 },
        { memory_id: "trip:2026-08-15", asset_id: "away-2", ordinal: 1 },
      ],
      onOpen: () => undefined,
    });
    expect(cards[0]!.title).toBe("2-day trip");
    // Still sketchable: the stop has coordinates even with no name.
    expect(cards[0]!.route).toHaveLength(1);
  });

  it("leaves the other kinds of memory exactly as they were", () => {
    const cards = buildMemories({
      ownAssets: LIBRARY,
      memories: [
        {
          memory_id: "otd:08-15",
          kind: "on-this-day",
          title_hint: "On 15 August",
          computed_at: "2026-08-15T00:00:00Z",
        },
        {
          memory_id: "similar:tahoe-1",
          kind: "similar",
          computed_at: "2026-08-14T00:00:00Z",
        },
      ],
      memoryMembers: [
        { memory_id: "otd:08-15", asset_id: "tahoe-1", ordinal: 0 },
        { memory_id: "similar:tahoe-1", asset_id: "tahoe-2", ordinal: 0 },
      ],
      onOpen: () => undefined,
    });
    expect(cards.map((card) => card.title)).toStrictEqual([
      "On this day",
      "Similar photographs",
    ]);
    expect(cards.every((card) => card.route === undefined)).toBe(true);
  });
});

describe("the memories strip's silence", () => {
  it("draws a trip's route from arithmetic, so a card fetches nothing to show it", () => {
    // Asserted against the SOURCE because that is where the regression would
    // land: a rendered card proves only that this test's fixture had no remote
    // cover, while a basemap tile URL or a static-map `<image>` added to the
    // sketch is the whole defect — the strip would look richer and emit the
    // coordinates of a member's holiday to whoever served the picture. The
    // blueprint CSP denies remote hosts anyway (docs/traps/blueprint-csp.md);
    // this keeps the card honest before it gets that far.
    const source = readFileSync(
      path.join(
        path.dirname(expect.getState().testPath!),
        "components",
        "Memories.tsx"
      ),
      "utf8"
    );
    expect(source).not.toMatch(/https?:\/\//u);
    expect(source).not.toMatch(/<image\b|\bfetch\(/u);
  });
});
