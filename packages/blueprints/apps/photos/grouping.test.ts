// The timeline's day sub-label, on the one point no cheaper layer holds: a
// coordinate is not a place name (issue #816).
//
// `photos-tile.test.ts` already owns the sub-label's grammar over named places
// (one place names the day, two places name nothing) and the month bucketing.
// What this file owns is the label's refusal: every place minted from GPS
// carries the digits `findOrCreatePlaceTx` wrote as its name until somebody
// renames it, and the timeline must not print them — `12 · 39.09680,
// -120.03240` beside a day at the lake, in the app's own voice, as if a person
// had typed it.
import { describe, expect, it } from "vitest";

import { dayMeta } from "./grouping.ts";
import type { Asset } from "./types.ts";

const frame = (place: Asset["place"]): Asset => ({
  asset_id: `a-${place?.place_id ?? "none"}`,
  taken_at: "2026-08-15T12:00:00Z",
  place,
});

const COORDINATE = { place_id: "p-gps", name: "39.09680, -120.03240" };

describe("the day sub-label", () => {
  it("counts the day instead of printing a coordinate as its name", () => {
    expect(dayMeta([frame(COORDINATE), frame(COORDINATE)])).toBe("2");
  });

  it("still names a day whose place a member named", () => {
    const cabin = { place_id: "p-cabin", name: "The cabin" };
    expect(dayMeta([frame(cabin), frame(cabin)])).toBe("2 · The cabin");
  });

  it("names nothing when one frame's place is a coordinate and another's is not", () => {
    // The named place is not "the day's place" — the day also holds a frame
    // this label has nothing to say about, and one of two is not all of them.
    expect(
      dayMeta([
        frame({ place_id: "p-cabin", name: "The cabin" }),
        frame(COORDINATE),
      ])
    ).toBe("2");
  });

  it("leaves an unplaced day as its count", () => {
    expect(dayMeta([frame(null), frame(null)])).toBe("2");
  });
});
