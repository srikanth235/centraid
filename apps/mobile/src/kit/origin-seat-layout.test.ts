import { describe, expect, it } from "vitest";

import {
  ACTIVITY_SECTION_ORDER,
  VAULT_SECTION_ORDER,
} from "./origin-seat-layout";

describe("Origin seat composition", () => {
  it("omits machine health from Activity", () => {
    expect(ACTIVITY_SECTION_ORDER).not.toContain("Gateway");
    expect(ACTIVITY_SECTION_ORDER).not.toContain("System");
  });

  it("composes Vault in the member-facing order", () => {
    expect(VAULT_SECTION_ORDER).toStrictEqual([
      "Contents",
      "Copies",
      "Sharing",
    ]);
  });
});
