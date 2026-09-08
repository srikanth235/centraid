import { describe, expect, it } from "vitest";

import type {
  VaultAgentEntry,
  VaultAppEntry,
} from "../../gateway-client-vault.js";
import { groupGrantsByStore, STORES } from "./privacyStores.js";

function app(
  appId: string,
  name: string,
  scopes: { schema: string; table?: string; verbs: string }[]
): VaultAppEntry {
  return {
    appId,
    name,
    status: "active",
    origin: "test",
    riskCeiling: "low",
    installedAt: "2026-01-01T00:00:00.000Z",
    scopes,
  };
}

describe(groupGrantsByStore, () => {
  it("returns every declared store, even with no holders", () => {
    const groups = groupGrantsByStore([], []);
    expect(groups.map((g) => g.storeId)).toStrictEqual(
      STORES.map((s) => s.storeId)
    );
    for (const group of groups) expect(group.holders).toStrictEqual([]);
  });

  it("routes a photos app's media scope to the photos store", () => {
    const photos = app("photos", "Photos", [
      { schema: "media", verbs: "read" },
      { schema: "media", table: "add_asset", verbs: "act" },
    ]);
    const groups = groupGrantsByStore([photos], []);
    const photosGroup = groups.find((g) => g.storeId === "photos");
    // A DECLARATION IS NOT A GRANT (#928 A1): an app's row carries no
    // authority to withdraw, so it names none and is not revocable.
    expect(photosGroup?.holders).toStrictEqual([
      {
        grantId: "",
        holderKind: "app",
        holderId: "photos",
        holderLabel: "Photos",
        mode: "write",
        revocable: false,
      },
    ]);
  });

  it("collapses read+act scopes in the same store into one write row", () => {
    const docsApp = app("docs", "Docs", [
      { schema: "core", table: "document", verbs: "read" },
      { schema: "core", table: "edit_document", verbs: "act" },
    ]);
    const groups = groupGrantsByStore([docsApp], []);
    const docsGroup = groups.find((g) => g.storeId === "docs");
    expect(docsGroup?.holders).toHaveLength(1);
    expect(docsGroup?.holders[0]?.mode).toBe("write");
  });

  it("routes shared core plumbing tables to the shared-identifiers store", () => {
    const someApp = app("x", "X", [
      { schema: "core", table: "content_item", verbs: "read" },
      { schema: "core", table: "tag", verbs: "read" },
    ]);
    const groups = groupGrantsByStore([someApp], []);
    const shared = groups.find((g) => g.storeId === "shared");
    expect(shared?.holders).toHaveLength(1);
    expect(shared?.holders[0]?.holderLabel).toBe("X");
  });

  it("includes agents alongside apps, sorted by label within a store", () => {
    const zebraApp = app("zebra", "Zebra", [
      { schema: "media", verbs: "read" },
    ]);
    const agent: VaultAgentEntry = {
      agentId: "agent-1",
      enrollmentKey: "k",
      partyId: "p",
      name: "Aardvark automation",
      modelRef: "test",
      enrolledAt: "2026-01-01T00:00:00.000Z",
      answers: [
        {
          authorityId: "agent-answer",
          principalId: "aardvark",
          subjectType: "automation.pack",
          subjectId: "media",
          verb: "read",
          decision: "granted",
          grantedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    const groups = groupGrantsByStore([zebraApp], [agent]);
    const photos = groups.find((g) => g.storeId === "photos");
    expect(photos?.holders.map((h) => h.holderLabel)).toStrictEqual([
      "Aardvark automation",
      "Zebra",
    ]);
    expect(photos?.holders[0]?.holderKind).toBe("agent");
  });

  it("a store nobody has scopes for is reachable by nothing", () => {
    const someApp = app("x", "X", [{ schema: "media", verbs: "read" }]);
    const groups = groupGrantsByStore([someApp], []);
    const locker = groups.find((g) => g.storeId === "locker");
    expect(locker?.holders).toStrictEqual([]);
  });
});
