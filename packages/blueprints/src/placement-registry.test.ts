/*
 * A4/A7 tripwires for `apps/_shared/placement-registry.ts` (issue #712).
 *
 *   - A4: `PlaceableItemType` must stay exactly `packages/vault`'s
 *     `ShareableItemType` minus `"locker.item"`. Blueprints cannot IMPORT
 *     `@centraid/vault` (see the registry's own header — that package is
 *     Node-only and blueprint apps are served straight to a browser), so
 *     this is a TRIPWIRE, not a type-level proof: it source-scans
 *     `closure.ts`'s literal array the same way `blueprint-seats.test.ts`
 *     source-scans `app.json` files, and fails loudly the moment the two
 *     lists drift instead of failing silently at a browser runtime that
 *     never typechecks against the real union.
 *   - A7: `"locker.item"` must never appear as a registry entry, and no
 *     `.tsx` source under `apps/` may pass it as a placement control's
 *     `itemType` — Locker is structurally excluded from sharing.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

// Loaded by file URL (the blueprint apps are browser ES modules outside this
// package's TS program — the same trick write-target.test.ts and
// docs-media.test.ts use), so the shape is declared locally.
interface PlacementEntity {
  itemType: string;
  appId: string;
  label: string;
}
const registryModuleUrl = pathToFileURL(
  path.resolve(import.meta.dirname, "../apps/_shared/placement-registry.ts")
).href;
const { PLACEABLE_ITEM_TYPES, PLACEMENT_REGISTRY } = (await import(
  registryModuleUrl
)) as {
  PLACEABLE_ITEM_TYPES: readonly string[];
  PLACEMENT_REGISTRY: readonly PlacementEntity[];
};

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const CLOSURE_PATH = path.resolve(
  PACKAGE_ROOT,
  "../vault/src/share/closure.ts"
);
const APPS_DIR = path.join(PACKAGE_ROOT, "apps");

/** Pull the quoted string literals out of vault's `SHAREABLE_ITEM_TYPES`
 *  array — a source scan, not an import, per the header above. */
function vaultShareableItemTypes(): string[] {
  const source = readFileSync(CLOSURE_PATH, "utf8");
  const match = source.match(
    /const SHAREABLE_ITEM_TYPES:[^=]*=\s*\[(?<literal>[^\]]*)\]/u
  );
  if (!match) {
    throw new Error(
      "SHAREABLE_ITEM_TYPES not found in packages/vault/src/share/closure.ts " +
        "— the tripwire's regex needs updating to match the new shape."
    );
  }
  return [...match[1]!.matchAll(/"(?<name>[^"]+)"/gu)].map((m) => m[1]!);
}

// Every TypeScript/TSX source file under this package's own `apps/` — the
// same universe `blueprint-seats.test.ts` scans.
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.(?:ts|tsx)$/u.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("placement registry (A4) mirrors vault's ShareableItemType minus locker.item", () => {
  const vaultTypes = vaultShareableItemTypes();

  it("vault's own list still contains locker.item — else this tripwire is stale", () => {
    // Sanity check on the scan itself: if vault ever drops locker.item from
    // ShareableItemType, the A7 exclusion becomes moot and this whole file's
    // premise needs revisiting, not a silent pass.
    expect(vaultTypes).toContain("locker.item");
  });

  it("PLACEABLE_ITEM_TYPES is exactly vault's list minus locker.item", () => {
    const expected = vaultTypes.filter((t) => t !== "locker.item").toSorted();
    expect([...PLACEABLE_ITEM_TYPES].toSorted()).toStrictEqual(expected);
  });

  it("every registry entry's itemType is unique", () => {
    const seen = new Set<string>();
    for (const entity of PLACEMENT_REGISTRY) {
      expect(seen.has(entity.itemType), `duplicate ${entity.itemType}`).toBe(
        false
      );
      seen.add(entity.itemType);
    }
  });
});

describe("locker is structurally excluded from placement (A7)", () => {
  it("locker.item is not a registry entry", () => {
    expect(
      PLACEMENT_REGISTRY.some((entity) => entity.itemType === "locker.item")
    ).toBe(false);
    expect(PLACEABLE_ITEM_TYPES).not.toContain("locker.item");
  });

  it("no bundled app source passes locker.item as a placement itemType", () => {
    const offenders = sourceFiles(APPS_DIR).filter((file) =>
      /itemType\s*[:=]\s*["']locker\.item["']/u.test(readFileSync(file, "utf8"))
    );
    expect(offenders).toStrictEqual([]);
  });
});
