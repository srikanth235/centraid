// EXACTLY ONE NAVIGATION FOR ONE SET OF DESTINATIONS — the rule the rail's
// definition of done states from both ends: "every destination in each rail is
// reachable on touch without the rail", and "a destination that exists only in
// the rail is a defect".
//
// The seat function is what makes both true by construction, so this suite
// asserts the property rather than the three branches: over every combination
// of the two signals, the answer is one of the three surfaces, and it is never
// the case that two draw or that none does.
import { describe, expect, it } from "vitest";

import { navSeat } from "./nav-seat.ts";

const SEATS = [
  { narrow: false, compact: false, seat: "rail", name: "1420 desk" },
  { narrow: true, compact: true, seat: "band", name: "390 phone" },
  // The two mixed seats, and neither is hypothetical: a pane inside the shell
  // can be much narrower than the viewport (a docked info rail, a split), and
  // a compact shell can be handed a wide pane.
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
    // A layout signal may hide a navigation ONLY where it knows the
    // replacement rendered. The pane's own width is not that knowledge: the
    // shell honours a claim on its form factor and on nothing else, so a
    // narrow pane at a desk keeps a navigation of its own.
    expect(navSeat({ narrow: true, compact: false })).not.toBe("band");
  });

  it("draws the rail only where there is room for a column beside the set", () => {
    expect(navSeat({ narrow: true, compact: false })).not.toBe("rail");
    expect(navSeat({ narrow: false, compact: true })).not.toBe("rail");
  });
});
