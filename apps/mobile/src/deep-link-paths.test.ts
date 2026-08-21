import { describe, expect, it } from "vitest";

import { SYSTEM_DEEP_LINK_PATH } from "./deep-link-paths";

describe("stable mobile deep-link paths", () => {
  it("keeps the gateway id for the Origin System explanation", () => {
    expect(SYSTEM_DEEP_LINK_PATH).toBe("gateway");
  });
});
