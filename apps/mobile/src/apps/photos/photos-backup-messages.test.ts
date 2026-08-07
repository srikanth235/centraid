// The sentences Back up says when it did NOT move bytes.
//
// Both exist because the run finishing is not the same as the run doing
// something, and a member cannot tell those apart from a haptic.

import { describe, expect, it } from "vitest";

import { inCloudMessage, nothingToBackUpMessage } from "./photos-backup-copy";

describe(nothingToBackUpMessage, () => {
  it("says nothing happened, and why, instead of confirming success", () => {
    // The defect: a selection of vault-resident photographs filters to empty,
    // the run completes with no transfers, and the old code fell through to a
    // SUCCESS haptic — a confirmation buzz for work that never happened.
    const one = nothingToBackUpMessage(1);
    expect(one).toContain("already on the gateway");
    expect(one).toContain("no copy on this device");
    // The reason a member can act on, never the field name behind it.
    expect(one).not.toContain("localId");
  });

  it("agrees with itself about how many photographs it is talking about", () => {
    expect(nothingToBackUpMessage(1)).toContain("That photograph");
    expect(nothingToBackUpMessage(4)).toContain("Those photographs");
  });
});

describe(inCloudMessage, () => {
  it("keeps leftovers selected, and says so", () => {
    expect(inCloudMessage(1)).toContain("is");
    expect(inCloudMessage(3)).toContain("are");
    expect(inCloudMessage(3)).toContain("still selected for retry");
  });
});
