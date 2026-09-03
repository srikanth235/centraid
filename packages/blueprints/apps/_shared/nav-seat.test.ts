import { describe, expect, it } from "vitest";

import { navSeat } from "./nav-seat.ts";

const SEATS = [
  { narrow: false, compact: false, seat: "rail", name: "1420 desk" },
  { narrow: true, compact: true, seat: "band", name: "390 phone" },
  {
    narrow: true,
    compact: false,
    seat: "strip",
    name: "narrow pane at a desk",
  },
  { narrow: false, compact: true, seat: "strip", name: "wide pane on a phone" },
] as const;

describe("which surface carries an app's own destinations", () => {
  it.each(SEATS)("$name → $seat", ({ narrow, compact, seat }) => {
    expect(navSeat({ narrow, compact })).toBe(seat);
  });

  it("always answers exactly one surface — never none, never two", () => {
    for (const narrow of [true, false]) {
      for (const compact of [true, false]) {
        const seat = navSeat({ narrow, compact });
        expect(["band", "strip", "rail"]).toContain(seat);
      }
    }
  });

  it("hands off to the band only where the shell honours a band claim", () => {
    expect(navSeat({ narrow: true, compact: false })).not.toBe("band");
  });

  it("draws the rail only where there is room for a column beside the set", () => {
    expect(navSeat({ narrow: true, compact: false })).not.toBe("rail");
    expect(navSeat({ narrow: false, compact: true })).not.toBe("rail");
  });
});
