/**
 * Names atlasOrreryCamera.ts (#545). Pure pan/zoom math lives in
 * atlasOrreryGeometry (already tested). Calling the hook outside a React
 * dispatcher must throw — pins the export is a real hook, not a no-op stub.
 */

import { describe, expect, it } from "vitest";

import { useOrreryCamera } from "./atlasOrreryCamera.js";

describe("useOrreryCamera module", () => {
  it("is a React hook (throws outside a React dispatcher)", () => {
    expect(useOrreryCamera.name).toBe("useOrreryCamera");
    // React 19 reports a null dispatcher via useState property access rather
    // than the classic "Invalid hook call" string — either is a real pin.
    expect(() => useOrreryCamera()).toThrow(
      /Invalid hook call|dispatcher|useState|Cannot read properties of null/iu
    );
  });
});
