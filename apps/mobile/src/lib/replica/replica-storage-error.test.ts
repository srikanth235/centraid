import { describe, expect, test } from "vitest";

import {
  asReplicaStorageError,
  isReplicaStorageFullError,
  ReplicaStorageFullError,
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
    expect(normalized.message).toContain("paused replica sync");
    expect(normalized.message).toContain("without deleting");
    expect(normalized.message).toContain("thumbnail cache");
  });

  test("does not misclassify unrelated SQLite failures", () => {
    const failure = new Error("UNIQUE constraint failed");
    expect(isReplicaStorageFullError(failure)).toBe(false);
    expect(asReplicaStorageError(failure)).toBe(failure);
  });
});
