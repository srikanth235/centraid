// The phone is the one seat with two live handles per replica file, so it
// must declare journal_mode=DELETE rather than inherit WAL from a neighbour.
import { describe, expect, it, vi } from "vitest";

const executeSync = vi.fn<(sql: string) => unknown>();

vi.mock(import("@op-engineering/op-sqlite"), () => ({
  open: () => ({
    close: () => undefined,
    execute: async () => ({ rows: [] }),
    executeBatch: async () => undefined,
    executeSync,
  }),
}));

const { OpSqliteDriver } = await import("./op-sqlite-driver");

describe("the phone replica driver", () => {
  it("declares the rollback journal the two-handle busy timeout assumes", () => {
    const driver = OpSqliteDriver.open({ name: "replica.sqlite3" });
    expect(driver.journalMode).toBe("DELETE");
    expect(executeSync).toHaveBeenCalledWith("PRAGMA busy_timeout=5000");
  });
});
