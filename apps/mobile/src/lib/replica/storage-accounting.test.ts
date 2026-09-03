import { describe, expect, test } from "vitest";

import {
  foldPendingUploadGroups,
  otherPhoneStorage,
  pendingBytesByVault,
  sqliteFamilyBytes,
} from "./storage-accounting";

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

  test("folds the SQL aggregate into vault, unassigned and grand totals", () => {
    const totals = foldPendingUploadGroups([
      { targetVaultId: "personal", bytes: 15, itemCount: 2, videoCount: 1 },
      { targetVaultId: "family", bytes: 20, itemCount: 1, videoCount: 0 },
      { bytes: 7, itemCount: 1, videoCount: 1 },
    ]);

    expect(Object.fromEntries(totals.byVault)).toStrictEqual({
      personal: { bytes: 15, itemCount: 2 },
      family: { bytes: 20, itemCount: 1 },
    });
    expect(
      totals.unassigned,
      "legacy pre-target rows stay their own bucket"
    ).toStrictEqual({ bytes: 7, itemCount: 1 });
    expect(totals.total).toStrictEqual({ bytes: 42, itemCount: 4 });
    expect(totals.videoCount).toBe(2);
  });

  test("an unassigned group is never folded into a vault total", () => {
    const totals = foldPendingUploadGroups([
      { bytes: 9, itemCount: 3, videoCount: 0 },
    ]);

    expect(totals.byVault.size).toBe(0);
    expect(totals.unassigned.bytes).toBe(9);
    expect(totals.total.bytes).toBe(9);
  });

  test("the aggregate agrees with a row-by-row sum over the same fixture", () => {
    const rows = [
      { plaintextSize: 10, targetVaultId: "personal" },
      { plaintextSize: 20, targetVaultId: "family" },
      { plaintextSize: 5, targetVaultId: "personal" },
      { plaintextSize: 7 },
    ];
    const groups = [
      { targetVaultId: "personal", bytes: 15, itemCount: 2, videoCount: 0 },
      { targetVaultId: "family", bytes: 20, itemCount: 1, videoCount: 0 },
      { bytes: 7, itemCount: 1, videoCount: 0 },
    ];

    const byRow = pendingBytesByVault(rows);
    const folded = foldPendingUploadGroups(groups);

    expect(
      Object.fromEntries(
        [...folded.byVault].map(([vaultId, bucket]) => [vaultId, bucket.bytes])
      )
    ).toStrictEqual(Object.fromEntries(byRow.byVault));
    expect(folded.unassigned.bytes).toBe(byRow.unassigned);
  });

  test("counts the upload ledger and every replica database no mounted scope claims", () => {
    const other = otherPhoneStorage(
      [
        { name: "centraid-uploads.db", size: 4_096 },
        { name: "centraid-uploads.db-wal", size: 1_024 },
        { name: "centraid-replica-mounted.sqlite3", size: 100 },
        { name: "centraid-replica-mounted.sqlite3-wal", size: 40 },
        { name: "centraid-replica-revoked.sqlite3", size: 900 },
        { name: "centraid-replica-revoked.sqlite3-shm", size: 32 },
        { name: "centraid-replica-gone.sqlite3", size: 7 },
        { name: "something-else.txt", size: 5_000 },
      ],
      ["/durable/CentraidReplica/centraid-replica-mounted.sqlite3"],
      "centraid-uploads.db"
    );

    expect(other.uploadLedgerBytes, "main file plus its WAL").toBe(5_120);
    expect(other.unmountedVaultBytes).toBe(939);
    expect(
      other.unmountedVaultCount,
      "sidecars belong to their main database, not to a database of their own"
    ).toBe(2);
  });

  test("reports nothing extra when every replica database is mounted", () => {
    expect(
      otherPhoneStorage(
        [{ name: "centraid-replica-one.sqlite3", size: 500 }],
        ["centraid-replica-one.sqlite3"],
        "centraid-uploads.db"
      )
    ).toStrictEqual({
      uploadLedgerBytes: 0,
      unmountedVaultBytes: 0,
      unmountedVaultCount: 0,
    });
  });
});
