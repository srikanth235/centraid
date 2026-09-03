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

  test("the marks a destination must not wear", () => {
    expect(DESTINATION_MARKS.analytics).not.toBe("Activity");
    expect(DESTINATION_MARKS.data).not.toBe("Folder");
    expect(DESTINATION_MARKS.devices).not.toBe("Monitor");
  });

  test("no two destinations share a mark", () => {
    const marks = Object.values(DESTINATION_MARKS);
    expect(new Set(marks).size).toBe(marks.length);
  });
});
