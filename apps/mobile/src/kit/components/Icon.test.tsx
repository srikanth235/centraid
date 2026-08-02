import { describe, expect, test } from "vitest";

import { resolveIconName } from "./icon-resolver";

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
