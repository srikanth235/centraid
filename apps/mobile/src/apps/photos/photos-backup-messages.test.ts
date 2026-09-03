import { describe, expect, it } from "vitest";

import { inCloudMessage, nothingToBackUpMessage } from "./photos-backup-copy";

describe(nothingToBackUpMessage, () => {
  it("says nothing happened, and why, instead of confirming success", () => {
    const one = nothingToBackUpMessage(1);
    expect(one).toContain("already on the gateway");
    expect(one).toContain("no copy on this device");
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
