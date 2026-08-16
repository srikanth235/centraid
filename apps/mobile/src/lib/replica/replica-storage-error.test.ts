import { describe, expect, test } from "vitest";

import {
  asReplicaStorageError,
  isReplicaStorageFullError,
  ReplicaStorageFullError,
  STORAGE_FULL_ACTION_LABEL,
  STORAGE_FULL_CONSEQUENCE,
} from "./replica-storage-error";

describe("native replica low-disk behavior", () => {
  test.each([
    Object.assign(new Error("no space left on device"), { code: "ENOSPC" }),
    Object.assign(new Error("database or disk is full"), {
      code: "SQLITE_FULL",
    }),
    Object.assign(new Error("database or disk is full"), { errcode: 13 }),
  ])("normalizes %s into an actionable, non-destructive error", (failure) => {
    expect(isReplicaStorageFullError(failure)).toBe(true);
    const normalized = asReplicaStorageError(failure);
    expect(normalized).toBeInstanceOf(ReplicaStorageFullError);
    expect(normalized.message).toContain("Phone storage is full");
    expect(normalized.message).toContain("sync is paused");
    expect(STORAGE_FULL_CONSEQUENCE).toContain("paused");
    expect(STORAGE_FULL_ACTION_LABEL).toContain("thumbnail cache");
  });

  test("does not misclassify unrelated SQLite failures", () => {
    const failure = new Error("UNIQUE constraint failed");
    expect(isReplicaStorageFullError(failure)).toBe(false);
    expect(asReplicaStorageError(failure)).toBe(failure);
  });
});
