import { describe, expect, test } from "vitest";

import { pendingBytesByVault, sqliteFamilyBytes } from "./storage-accounting";

describe("phone storage accounting", () => {
  test("counts a replica's main database and every live SQLite sidecar", () => {
    const sizes = new Map([
      ["/replica.db", 100],
      ["/replica.db-wal", 30],
      ["/replica.db-shm", 10],
      ["/replica.db-journal", 5],
    ]);
    expect(
      sqliteFamilyBytes("/replica.db", (path) => sizes.get(path) ?? 0)
    ).toBe(145);
  });

  test("attributes pending bytes to their durable target, never current focus", () => {
    const result = pendingBytesByVault([
      { plaintextSize: 10, targetVaultId: "personal" },
      { plaintextSize: 20, targetVaultId: "family" },
      { plaintextSize: 5, targetVaultId: "personal" },
      { plaintextSize: 7 },
    ]);
    expect(Object.fromEntries(result.byVault)).toStrictEqual({
      personal: 15,
      family: 20,
    });
    expect(result.unassigned).toBe(7);
  });
});
