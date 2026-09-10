// THE SEAT'S TWO EXTENSIONS, PROBED AT OPEN (#1011).
//
// Offline search on the phone is keyword (fts5) plus people / similar faces
// (sqlite-vec), both answered out of the seat's own file. A build that
// compiled one of them out opens fine and fails inside a query, so the driver
// asks at open — and these are the cases for what it asks and what it says.
import { beforeEach, describe, expect, it, vi } from "vitest";

const openDatabaseSync = vi.fn<(...args: unknown[]) => unknown>();
/** What `withSQLiteVecExtension: true` puts in the bundle — a PATH, not a load. */
const bundledExtensions = {
  "sqlite-vec": {
    libPath: "/bundle/vec.framework/vec",
    entryPoint: "sqlite3_vec_init",
  },
};

vi.mock(
  import("expo-sqlite"),
  () => ({ openDatabaseSync, bundledExtensions }) as never
);
vi.mock(
  import("../../../modules/centraid-storage"),
  () =>
    ({
      pathToFileUri: (path: string) => `file://${path}`,
    }) as never
);

const { ExpoSeatDriver } = await import("./expo-seat-driver");
const { EXPECTED_SQLITE_VEC_VERSION } = await import("./sqlite-vec-version");

/** A handle that runs everything, answering the pinned sqlite-vec version. */
function handle(options?: {
  readonly failOn?: RegExp;
  readonly vecVersion?: string;
  readonly failure?: Error;
  /** `false` for a handle that answers vec0 without being asked to load it. */
  readonly vecNeedsLoad?: boolean;
}) {
  const statements: string[] = [];
  const loaded: { libPath: string; entryPoint?: string }[] = [];
  // THE REAL HANDLE'S SHAPE (#1011): `vec0` and `vec_version()` exist only
  // after this connection has loaded the extension. `withSQLiteVecExtension`
  // bundles the framework and publishes its path; expo-sqlite loads nothing
  // by itself, so a driver that never asks gets `no such module` on a build
  // that is entirely correct.
  const vecReady = (): boolean =>
    options?.vecNeedsLoad === false || loaded.length > 0;
  return {
    statements,
    loaded,
    db: {
      loadExtensionSync: (libPath: string, entryPoint?: string) => {
        loaded.push({ libPath, ...(entryPoint ? { entryPoint } : {}) });
      },
      execSync: (sql: string) => {
        statements.push(sql);
        if (/vec0|vec_version/u.test(sql) && !vecReady())
          throw new Error("no such module: vec0");
        if (options?.failOn?.test(sql))
          throw options.failure ?? new Error("no such module");
      },
      getFirstSync: (sql: string) => {
        if (/vec_version/u.test(sql) && !vecReady())
          throw new Error("no such function: vec_version");
        return { version: options?.vecVersion ?? EXPECTED_SQLITE_VEC_VERSION };
      },
      closeSync: () => {},
    },
  };
}

describe("the seat driver's capability probes", () => {
  beforeEach(() => {
    openDatabaseSync.mockReset();
  });

  it("probes fts5 and vec0 in temp, writing nothing to the seat file", () => {
    const { db, statements } = handle();
    openDatabaseSync.mockReturnValue(db);

    expect(() => ExpoSeatDriver.open({ name: "vault.db" })).not.toThrow();
    expect(statements.some((sql) => /temp\.__fts5_probe/u.test(sql))).toBe(
      true
    );
    expect(
      statements.some((sql) => /temp\.__sqlite_vec_probe/u.test(sql))
    ).toBe(true);
    // Every probe statement names `temp.`; nothing touches the copied file.
    for (const sql of statements.filter((s) => /_probe/u.test(s)))
      expect(sql).toContain("temp.__");
  });

  it("loads the bundled sqlite-vec on the handle before probing it", () => {
    // THE REGRESSION (#1011). The probe was added without the load, so on the
    // real phone `vec_version()` answered `no such function`, `open()` threw
    // `ReplicaSqliteVecUnavailableError`, `openMountSeat` swallowed it, and
    // the provider never mounted a seat at all — an empty library, no seat,
    // and not one request to the gateway, on a build whose `vec.framework`
    // was sitting in the bundle.
    const { db, loaded, statements } = handle();
    openDatabaseSync.mockReturnValue(db);

    expect(() => ExpoSeatDriver.open({ name: "vault.db" })).not.toThrow();
    expect(loaded).toStrictEqual([
      { libPath: "/bundle/vec.framework/vec", entryPoint: "sqlite3_vec_init" },
    ]);
    // And it is loaded BEFORE the probe asks — the order is the whole fix.
    expect(statements.some((sql) => /vec0/u.test(sql))).toBe(true);
  });

  it("still refuses when the bundled extension will not load", () => {
    // A build that publishes a path to a framework that is not there is the
    // one case the load cannot rescue, and it must reach the member as the
    // build fault it is rather than as silence.
    const { db } = handle();
    openDatabaseSync.mockReturnValue({
      ...db,
      loadExtensionSync: () => {
        throw new Error("dlopen failed");
      },
    });

    expect(() => ExpoSeatDriver.open({ name: "vault.db" })).toThrow(
      /withSQLiteVecExtension: true/u
    );
  });

  it("refuses a build without fts5, naming the flag that fixes it", () => {
    const { db } = handle({ failOn: /fts5/u });
    openDatabaseSync.mockReturnValue(db);

    expect(() => ExpoSeatDriver.open({ name: "vault.db" })).toThrow(
      /enableFTS: true/u
    );
  });

  it("refuses a build without sqlite-vec, naming the flag and the iOS script", () => {
    const { db } = handle({ failOn: /vec0/u, vecNeedsLoad: false });
    openDatabaseSync.mockReturnValue(db);

    expect(() => ExpoSeatDriver.open({ name: "vault.db" })).toThrow(
      /withSQLiteVecExtension: true[\s\S]*build-sqlite-vec-ios\.sh/u
    );
  });

  it("refuses a sqlite-vec that is not the version this build pins", () => {
    const { db } = handle({ vecVersion: "v0.1.6", vecNeedsLoad: false });
    openDatabaseSync.mockReturnValue(db);

    expect(() => ExpoSeatDriver.open({ name: "vault.db" })).toThrow(
      new RegExp(`v0\\.1\\.6[\\s\\S]*${EXPECTED_SQLITE_VEC_VERSION}`, "u")
    );
  });

  it("does not pin a vector WIDTH: the probe table is one float wide", () => {
    // The gateway decides the face-embedding dimension (SFace 128 → ArcFace
    // 512) and the phone stores whatever replicates. A probe that asserted a
    // width would be the phone's own opinion about a number it does not own.
    const { db, statements } = handle();
    openDatabaseSync.mockReturnValue(db);
    ExpoSeatDriver.open({ name: "vault.db" });

    const probe = statements.find((sql) => sql.includes("vec0")) ?? "";
    expect(probe).toContain("float[1]");
    expect(probe).not.toMatch(/float\[(?:128|512)\]/u);
  });

  it("keeps a disk-full failure in the storage taxonomy, not the build one", () => {
    const full = new Error("database or disk is full");
    const { db } = handle({ failOn: /fts5/u, failure: full });
    openDatabaseSync.mockReturnValue(db);

    expect(() => ExpoSeatDriver.open({ name: "vault.db" })).toThrow(/full/u);
  });
});
