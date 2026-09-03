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
