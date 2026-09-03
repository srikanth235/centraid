import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const here = import.meta.dirname;
const mobileRoot = path.resolve(here, "../../..");
const repoRoot = path.resolve(mobileRoot, "../..");

const readJson = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

const fts5Of = (file: string): unknown =>
  (readJson(file)["op-sqlite"] as Record<string, unknown> | undefined)?.[
    "fts5"
  ];

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
      return;
    }

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
