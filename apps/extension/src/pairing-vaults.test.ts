import { describe, expect, it } from "vitest";

import { normalizePairingVaults } from "./pairing-vaults.js";

describe(normalizePairingVaults, () => {
  it("keeps the primary vault first and preserves all grant metadata", () => {
    expect(
      normalizePairingVaults({
        vaultId: "personal",
        vaultIds: ["family", "personal"],
        vaults: [
          {
            enrollmentId: "family-enrollment",
            role: "read",
            vaultId: "family",
            vaultName: "Family",
          },
          {
            enrollmentId: "personal-enrollment",
            role: "write",
            vaultId: "personal",
            vaultName: "Personal",
          },
        ],
      })
    ).toStrictEqual([
      {
        enrollmentId: "personal-enrollment",
        role: "write",
        vaultId: "personal",
        vaultName: "Personal",
      },
      {
        enrollmentId: "family-enrollment",
        role: "read",
        vaultId: "family",
        vaultName: "Family",
      },
    ]);
  });

  it("keeps legacy primary-only responses usable", () => {
    expect(normalizePairingVaults({ vaultId: "personal" })).toStrictEqual([
      { vaultId: "personal" },
    ]);
  });
});
