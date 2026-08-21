import { describe, expect, test } from "vitest";

import { DESTINATION_MARKS } from "./destinations";
import { icons, isIconName } from "./icons";

describe("destination marks", () => {
  test("every mark resolves to a real registry glyph", () => {
    for (const [concept, name] of Object.entries(DESTINATION_MARKS)) {
      expect(isIconName(name), `${concept} -> ${name}`).toBe(true);
      expect(icons[name].length, `${concept} -> ${name}`).toBeGreaterThan(0);
    }
  });

  // The three that were wrong on BOTH surfaces before this table existed. Each
  // near-miss is pinned by the mark it must NOT be, because "Analytics is a
  // bar chart" is satisfied by any bar chart while "Analytics is not the
  // liveness pulse" is the thing that actually regressed.
  test("the marks a destination must not wear", () => {
    expect(DESTINATION_MARKS.analytics).not.toBe("Activity");
    expect(DESTINATION_MARKS.data).not.toBe("Folder");
    expect(DESTINATION_MARKS.devices).not.toBe("Monitor");
  });

  // A concept two destinations share is a concept that has stopped
  // distinguishing them — the failure this table exists to prevent, one level
  // up from the icon itself.
  test("no two destinations share a mark", () => {
    const marks = Object.values(DESTINATION_MARKS);
    expect(new Set(marks).size).toBe(marks.length);
  });
});
