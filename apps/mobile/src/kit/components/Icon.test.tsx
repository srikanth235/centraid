import { describe, expect, test } from "vitest";

import { resolveIconName } from "./icon-resolver";
import { resolveStrokeWidth } from "./icon-stroke-width";

describe("mobile icon adapter", () => {
  test("resolves navigation aliases to the shared semantic glyphs", () => {
    expect(resolveIconName("grid")).toBe("Grid");
    expect(resolveIconName("list")).toBe("List");
    expect(resolveIconName("book-open")).toBe("Book");
    expect(resolveIconName("chevron-left")).toBe("ChevronLeft");
    expect(resolveIconName("cloud-off")).toBe("CloudOff");
  });

  test("fails loudly for an unknown glyph name", () => {
    expect(() => resolveIconName("not-a-real-icon")).toThrow(
      "Unknown mobile icon name"
    );
  });
});

// packages/design/src/icons.ts's own header: "the caller sets stroke-width
// (1.6, 1.75 below 16px)" — the default now derives from `size` instead of a
// flat constant, so every caller that wasn't overriding it gets the rule.
describe("Icon's default stroke width", () => {
  test("is 1.6 at or above the 16px glyph threshold", () => {
    expect(resolveStrokeWidth(20)).toBe(1.6);
    expect(resolveStrokeWidth(16)).toBe(1.6);
  });

  test("is 1.75 below 16px", () => {
    expect(resolveStrokeWidth(12)).toBe(1.75);
  });

  test("an explicit strokeWidth override always wins", () => {
    expect(resolveStrokeWidth(20, 2.5)).toBe(2.5);
    expect(resolveStrokeWidth(12, 1.9)).toBe(1.9);
  });
});
