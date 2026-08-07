import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// The native replica needs FTS5 (see replica-fts5-error.ts). FTS5 is not a
// runtime flag — it is a compile-time define that op-sqlite turns on only when
// it finds `"op-sqlite": { "fts5": true }` in a package.json it resolves
// ITSELF. The two native toolchains resolve DIFFERENT files:
//
//   iOS  (op-sqlite.podspec): walks UP from node_modules/@op-engineering/
//        op-sqlite and takes the FIRST package.json it finds. bun hoists
//        op-sqlite to the repo root, so that file is the ROOT package.json —
//        NOT apps/mobile/package.json.
//   Android (android/build.gradle): `isUserApp` is false for an app build
//        (gradle rootDir = apps/mobile/android, no "node_modules" in the
//        path), so it reads `$rootDir/../package.json` = apps/mobile/
//        package.json.
//
// So the block must exist in BOTH files. Declaring it only on the app silently
// ships an iOS build with no FTS5 (the podspec logs nothing about fts5 — the
// only tell is a missing SQLITE_ENABLE_FTS5=1 in the generated xcconfig).
//
// `sqliteVec` (issue #721) rides the exact same pair of files and the exact
// same two-toolchain resolution story — it is a second flag op-sqlite reads
// off the identical `"op-sqlite"` block, nothing more — so it is asserted
// alongside `fts5` below rather than in a file of its own.
const here = import.meta.dirname;
const mobileRoot = path.resolve(here, "../../..");
const repoRoot = path.resolve(mobileRoot, "../..");

const readJson = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

const fts5Of = (file: string): unknown =>
  (readJson(file)["op-sqlite"] as Record<string, unknown> | undefined)?.[
    "fts5"
  ];

// `sqliteVec` (issue #721) is the SAME compile-time-define story as `fts5`
// above — op-sqlite reads it from the identical two package.json files, via
// the identical two toolchains — so it has to clear the identical bar: both
// files, or a build silently misses the extension a future vector-search
// consumer needs. See `replica-sqlite-vec-error.ts` and
// `op-sqlite-driver.ts#probeSqliteVec` for the runtime side of this pairing.
const sqliteVecOf = (file: string): unknown =>
  (readJson(file)["op-sqlite"] as Record<string, unknown> | undefined)?.[
    "sqliteVec"
  ];

describe("op-sqlite native build config", () => {
  it("declares fts5 in the ROOT package.json (the file the iOS podspec reads)", () => {
    expect(fts5Of(path.join(repoRoot, "package.json"))).toBe(true);
  });

  it("declares fts5 in apps/mobile/package.json (the file the Android gradle reads)", () => {
    expect(fts5Of(path.join(mobileRoot, "package.json"))).toBe(true);
  });

  it("declares sqliteVec in the ROOT package.json (the file the iOS podspec reads)", () => {
    expect(sqliteVecOf(path.join(repoRoot, "package.json"))).toBe(true);
  });

  it("declares sqliteVec in apps/mobile/package.json (the file the Android gradle reads)", () => {
    expect(sqliteVecOf(path.join(mobileRoot, "package.json"))).toBe(true);
  });

  it("root package.json is what the podspec upward walk actually lands on", () => {
    const pkgDir = path.join(
      repoRoot,
      "node_modules/@op-engineering/op-sqlite"
    );
    if (!existsSync(pkgDir)) {
      // Dependencies not installed (e.g. a docs-only checkout); the two
      // assertions above still pin the config placement.
      return;
    }

    // Mirror op-sqlite.podspec: start one level above the package dir and take
    // the first package.json found walking up to the filesystem root.
    let current = path.dirname(pkgDir);
    let found: string | undefined;
    for (;;) {
      const candidate = path.join(current, "package.json");
      if (existsSync(candidate)) {
        found = candidate;
        break;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }

    expect(found).toBe(path.join(repoRoot, "package.json"));
  });
});
