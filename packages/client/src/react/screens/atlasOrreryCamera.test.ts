import { describe, expect, it } from "vitest";

import { useOrreryCamera } from "./atlasOrreryCamera.js";

describe("useOrreryCamera module", () => {
  it("is a React hook (throws outside a React dispatcher)", () => {
    expect(useOrreryCamera.name).toBe("useOrreryCamera");
    expect(() => useOrreryCamera()).toThrow(
      /Invalid hook call|dispatcher|useState|Cannot read properties of null/iu
    );
  });
});
