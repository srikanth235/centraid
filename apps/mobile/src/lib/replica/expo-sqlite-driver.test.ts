// The phone's engine changed in #996 wave 3: expo-sqlite over SQLCipher, one
// writer plus the background task, WAL. Two claims that a device cannot be
// asked about here but a mock can: the KEY is the first statement on the
// handle, and a second handle asks for its own connection.
import { describe, expect, it, vi } from "vitest";

const execSync = vi.fn<(sql: string) => unknown>();
const openDatabaseSync =
  vi.fn<(name: string, options: unknown, directory?: string) => unknown>();

vi.mock(
  import("expo-sqlite"),
  () =>
    ({
      openDatabaseSync: (
        name: string,
        options: unknown,
        directory?: string
      ) => {
        openDatabaseSync(name, options, directory);
        return {
          closeSync: () => undefined,
          execSync,
          getAllAsync: async () => [],
          getAllSync: () => [],
          runAsync: async () => ({ lastInsertRowId: 0, changes: 0 }),
          runSync: () => ({ lastInsertRowId: 0, changes: 0 }),
          withTransactionAsync: async (task: () => Promise<void>) => {
            await task();
          },
        };
      },
    }) as never
);

const driverModule = await import("./expo-sqlite-driver");
const { ExpoSqliteDriver, keyPragma } = driverModule;

describe("the phone replica driver", () => {
  it("declares WAL now that only the writer and the background task share the file", () => {
    execSync.mockClear();
    const driver = ExpoSqliteDriver.open({ name: "replica.sqlite3" });
    expect(driver.journalMode).toBe("WAL");
    expect(execSync).toHaveBeenCalledWith("PRAGMA busy_timeout=5000");
  });

  it("keys the handle BEFORE its first write, because a keyed file answers SQLITE_NOTADB otherwise", () => {
    execSync.mockClear();
    ExpoSqliteDriver.open({ name: "replica.sqlite3", key: "passphrase" });
    expect(execSync.mock.calls[0]?.[0]).toBe("PRAGMA key = 'passphrase'");
  });

  it("has no key statement at all when there is no key, rather than an empty one", () => {
    execSync.mockClear();
    ExpoSqliteDriver.open({ name: "replica.sqlite3" });
    expect(execSync.mock.calls.map((call) => call[0])).not.toContain(
      "PRAGMA key = ''"
    );
  });

  it("escapes a quote in the passphrase the only way a SQL literal can", () => {
    expect(keyPragma("it's")).toBe("PRAGMA key = 'it''s'");
  });

  // The WAL declaration above is only safe because nothing else opens the
  // same seat file. Keeping that structural rather than commented is the point:
  // there is no exported way to open a second handle on one, so the pair
  // "WAL + a second attached reader" cannot be assembled by accident.
  it("exports no opener for a second handle on a seat file", () => {
    expect(Object.keys(driverModule)).not.toContain(
      "openMountedReplicaReaderDriver"
    );
    expect(
      Object.keys(driverModule).filter((name) => name.startsWith("open"))
    ).toStrictEqual(["openNativeReplicaDriver"]);
  });

  it("still asks for its own connection when one is explicitly requested", () => {
    // expo caches by database NAME: without this, a second handle IS the
    // first, and closing either closes both.
    openDatabaseSync.mockClear();
    ExpoSqliteDriver.open({ name: "replica.sqlite3", useNewConnection: true });
    expect(openDatabaseSync.mock.calls[0]?.[1]).toStrictEqual({
      useNewConnection: true,
    });
  });
});
