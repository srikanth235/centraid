import { describe, expect, it } from "vitest";

import { companionModuleState } from "./companion-grants.js";

describe("Companion module state", () => {
  it("goes dark the moment the owner drops the module from the profile", () => {
    // The companion set is the owner's answer about this seat; an app being
    // installed here never overrides it.
    expect(companionModuleState(new Set(), "locker", true)).toBe("revoked");
    expect(companionModuleState(new Set(["notes"]), "notes", true)).toBe(
      "granted"
    );
  });

  it("distinguishes profile revocation from an app that is not installed", () => {
    expect(companionModuleState(new Set(), "notes", false)).toBe("revoked");
    expect(companionModuleState(new Set(["notes"]), "notes", false)).toBe(
      "unavailable"
    );
  });

  it("a selected module whose app IS installed is granted — a first-party app never parks (#928)", () => {
    // `parked` left this vocabulary with the app grant plane: an app is not a
    // principal, so "installed but not yet answered for" cannot occur.
    for (const module of ["locker", "tasks", "docs", "agenda"] as const) {
      expect(companionModuleState(new Set([module]), module, true)).toBe(
        "granted"
      );
    }
  });
});
