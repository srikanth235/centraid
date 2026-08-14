import { describe, expect, it } from "vitest";

import { memberFacingError } from "./member-error";

describe(memberFacingError, () => {
  it("removes architecture nouns without losing the actionable refusal", () => {
    expect(
      memberFacingError(
        "Gateway daemon refused HTTP 507: replica component disk is full"
      )
    ).toBe("vault service refused HTTP 507: offline copy part disk is full");
  });

  it("leaves ordinary causes unchanged", () => {
    expect(
      memberFacingError("Wi-Fi is off; try again on a trusted network")
    ).toBe("Wi-Fi is off; try again on a trusted network");
  });

  it("rewrites plural transport vocabulary", () => {
    expect(
      memberFacingError("Gateways and replicas reported failed components")
    ).toBe("vault hosts and offline copies reported failed parts");
  });
});
