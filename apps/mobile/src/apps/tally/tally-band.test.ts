// THE BAND TALLY CLAIMS, pinned (Tally spec §1, "Phone band").
//
// Four claims a plausible refactor could undo silently:
//
//  1. THE FIVE WORDS ARE THE SPEC'S — Balances · Activity · Groups · Waiting ·
//     More — and they come from the SHARED table, so the band, the desktop
//     rail and the app bar cannot disagree about what a place is called.
//  2. WAITING HOLDS A SLOT AND CARRIES NO COUNT. The sanctioned divergence is
//     the slot; a badge on it is what the spec forbids outright, so nothing in
//     the destination shape can hold a number.
//  3. THE CAP IS FIVE, and it is enforced rather than assumed.
//  4. EVERY MORE ROW LEADS SOMEWHERE. Export's door is on the custodian seat,
//     so it leads to a screen saying where the act happens; a greyed control
//     would teach that it is broken.
import { describe, expect, it } from "vitest";

import {
  BAND_DESTINATIONS,
  EXPORT,
  MORE_SHELVES,
} from "@centraid/blueprints/apps/tally/shelves";

import {
  BAND_CAPSULE,
  TALLY_BAND_DESTINATIONS,
  TALLY_BAND_MAX_DESTINATIONS,
  TALLY_MORE_ROWS,
  resolveTallyBand,
  resolveTallyMoreRoute,
} from "./tally-band";

describe("Tally's band", () => {
  it("is the spec's five words, in the spec's order", () => {
    expect(TALLY_BAND_DESTINATIONS.map((row) => row.label)).toStrictEqual([
      "Balances",
      "Activity",
      "Groups",
      "Waiting",
      "More",
    ]);
  });

  it("takes its four places from the shared table, not a local respelling", () => {
    expect(
      TALLY_BAND_DESTINATIONS.slice(0, 4).map((row) => row.key)
    ).toStrictEqual(BAND_DESTINATIONS.map((row) => row.id));
  });

  it("carries no count on any destination — a badge is what §1 forbids", () => {
    for (const destination of TALLY_BAND_DESTINATIONS) {
      expect(Object.keys(destination).sort()).toStrictEqual([
        "icon",
        "key",
        "label",
      ]);
    }
  });

  it("stays inside the frame's cap of five", () => {
    expect(TALLY_BAND_DESTINATIONS.length).toBeLessThanOrEqual(
      TALLY_BAND_MAX_DESTINATIONS
    );
  });

  it("hands the band back whole when the app owns it", () => {
    const band = resolveTallyBand("app");
    expect(band.owner).toBe("app");
    if (band.owner !== "app") throw new Error("expected the app's band");
    expect(band.destinations).toHaveLength(5);
    expect(band.capsule).toStrictEqual(BAND_CAPSULE);
  });

  it("draws only the frame's capsule when the host owns the band", () => {
    expect(resolveTallyBand("host")).toStrictEqual({ owner: "host" });
  });

  it("keeps the capsule out of the tab group — it is a frame control", () => {
    expect(BAND_CAPSULE.inTabGroup).toBe(false);
    expect(BAND_CAPSULE.edge).toBe("leading");
  });
});

describe("the More sheet", () => {
  it("is the shared sheet's shelves, in the shared sheet's order", () => {
    expect(TALLY_MORE_ROWS.map((row) => row.shelf)).toStrictEqual([
      ...MORE_SHELVES,
    ]);
  });

  it("names Export as the one act that happens on another seat", () => {
    const elsewhere = TALLY_MORE_ROWS.filter(
      (row) => row.reach === "elsewhere"
    );
    expect(elsewhere.map((row) => row.shelf)).toStrictEqual([EXPORT]);
  });

  it("gives every row a route, so none is a control with nothing behind it", () => {
    for (const row of TALLY_MORE_ROWS)
      expect(resolveTallyMoreRoute(row.key)).toMatch(/^Tally/u);
  });

  it("sends Export to the screen that states where the act happens", () => {
    expect(resolveTallyMoreRoute("export")).toBe("TallySurface");
  });
});
