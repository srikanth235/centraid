import { describe, expect, it } from "vitest";

import { BAND_DESTINATIONS } from "@centraid/blueprints/apps/agenda/views";

import {
  BAND_CAPSULE,
  AGENDA_BAND_DESTINATIONS,
  AGENDA_BAND_MAX_DESTINATIONS,
  resolveAgendaBand,
} from "./agenda-band";

describe("the band Agenda claims", () => {
  it("sits at the cap: four destinations plus More", () => {
    expect(AGENDA_BAND_DESTINATIONS).toHaveLength(AGENDA_BAND_MAX_DESTINATIONS);
    expect(AGENDA_BAND_DESTINATIONS.map((entry) => entry.key)).toStrictEqual([
      "day",
      "schedule",
      "waiting",
      "search",
      "more",
    ]);
  });

  it("says the blueprint's own words and glyphs, never a second spelling", () => {
    expect(
      AGENDA_BAND_DESTINATIONS.slice(0, 4).map((entry) => ({
        id: entry.key,
        label: entry.label,
        icon: entry.icon,
      }))
    ).toStrictEqual(BAND_DESTINATIONS.map((entry) => ({ ...entry })));
  });

  it("draws no Month or Week tab: the touch table carries neither", () => {
    const keys = AGENDA_BAND_DESTINATIONS.map((entry) => entry.key);
    expect(keys).not.toContain("month");
    expect(keys).not.toContain("week");
  });

  it("gives every tab a label — a glyph alone is not a name", () => {
    for (const destination of AGENDA_BAND_DESTINATIONS) {
      expect(destination.label.length).toBeGreaterThan(0);
      expect(destination.icon.length).toBeGreaterThan(0);
    }
  });

  it("resolves to the app's band by default and keeps the capsule on the host's", () => {
    const app = resolveAgendaBand("app");
    expect(app.owner).toBe("app");
    expect(resolveAgendaBand("host")).toStrictEqual({
      owner: "host",
      capsule: BAND_CAPSULE,
    });
  });
});
