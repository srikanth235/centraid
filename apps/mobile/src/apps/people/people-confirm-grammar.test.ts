// #1015 (people/findings #7) — the channel `✕` destroyed a phone number on one
// tap, from a 44pt target beside the row's own open-the-person target, with no
// confirm and no undo. `people-writes.ts` posts no Undo for it and correctly
// cannot: there is no reverse write. The divergence register sanctions the
// absence of a FAKE undo, not the absence of both guards — so the act joins
// Trash and Merge on the modal.
import { describe, expect, it } from "vitest";

import {
  CONFIRMS,
  ROUTE_TITLES,
  VERBS,
} from "@centraid/blueprints/apps/people/people-copy";

describe("People's modal confirms", () => {
  it("covers every act no reverse write can undo", () => {
    expect(Object.keys(CONFIRMS).sort()).toStrictEqual([
      "merge",
      "removeChannel",
      "trash",
    ]);
  });

  it("names the thing it is about to destroy, and says there is no way back", () => {
    expect(CONFIRMS.removeChannel.title("phone number")).toBe(
      "Remove this phone number?"
    );
    expect(CONFIRMS.removeChannel.body).toBe("There is no undo for this one.");
    // The word on the control is the app's own remove verb, not a glyph.
    expect(CONFIRMS.removeChannel.verb).toBe(VERBS.remove);
  });

  it("gives every pushed route a name of its own", () => {
    expect(Object.values(ROUTE_TITLES).sort()).toStrictEqual([
      "Edit person",
      "Log a touch",
      "Merge",
      "New person",
      "Trash",
    ]);
  });
});
