import { describe, expect, it } from "vitest";

import { SYSTEM_ON_PHONE } from "./system-on-phone";

describe("System on the Origin seat", () => {
  it("explains the host-only seam and offers a real redirect", () => {
    expect(SYSTEM_ON_PHONE.body).toContain("This phone has no gateway");
    expect(SYSTEM_ON_PHONE).toMatchObject({
      actionLabel: "Open Activity",
      destination: "activity",
      title: "System",
    });
  });
});
