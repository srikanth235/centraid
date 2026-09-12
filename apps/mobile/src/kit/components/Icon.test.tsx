import { describe, expect, test } from "vitest";

import { resolveIconFill } from "./icon-fill";
import { resolveIconName } from "./icon-resolver";
import { resolveStrokeWidth } from "./icon-stroke-width";

describe("mobile icon adapter", () => {
  test("resolves navigation aliases to the shared semantic glyphs", () => {
    expect(resolveIconName("grid")).toBe("Grid");
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

// A filled-vs-unfilled state is the icon's contract, not an app's (#1015):
// People drew its own starred star before this existed, at its own weight.
describe("Icon's fill", () => {
  test("is off by default, so no existing glyph moves", () => {
    expect(resolveIconFill("#111", false)).toBe("none");
  });

  test("fills in the stroke's own ink when asked — there is one tone", () => {
    expect(resolveIconFill("#111", true)).toBe("#111");
  });

  test("still honours a registry path that fills itself", () => {
    expect(resolveIconFill("#111", false, "currentColor")).toBe("#111");
  });

  test("leaves any other declared path fill alone", () => {
    expect(resolveIconFill("#111", false, "none")).toBe("none");
  });
});
