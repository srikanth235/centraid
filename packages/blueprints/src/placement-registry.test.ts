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
  // [law:placement-registry-parity] Every placeable entity is enumerated once.
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

/*
 * A6 — THE LEDGER-ROOT AUDIT. Tally is the app whose whole posture is "born
 * shared": a Splitwise group is a multi-party balance and belongs in a
 * household vault from the moment it exists. It is therefore the honest test
 * of whether engine A is an ENGINE or just Photos' sharing code with a wider
 * type — the issue's own framing is that whatever edit Tally needs is an
 * ENGINE DEFECT, not a Tally patch.
 *
 * VERDICT: it consumes cleanly. Tally supplies a registry row and two call
 * sites; the engine has no Tally-shaped code in it at all. These assertions
 * are what would go red if someone "fixed" that by teaching the engine about
 * an app.
 */
describe("Tally consumes the placement engine with zero engine edits (A6)", () => {
  const ENGINE_FILES = [
    path.join(APPS_DIR, "_shared", "placement-registry.ts"),
    path.join(APPS_DIR, "_shared", "ShareSheet.tsx"),
    path.resolve(
      PACKAGE_ROOT,
      "../../apps/mobile/src/kit/share/ShareSheet.tsx"
    ),
  ];

  it("tally.group is an ordinary registry row, owned by tally", () => {
    const entry = PLACEMENT_REGISTRY.find((e) => e.itemType === "tally.group");
    expect(entry).toStrictEqual({
      appId: "tally",
      itemType: "tally.group",
      label: "group",
    });
  });

  it("no engine module branches on an app id or an item type", () => {
    // The registry file itself names apps — that is what a registry IS — so
    // only the RENDERERS are held to this. A renderer that grew an
    // `if (itemType === "tally.group")` would be the fourth hand-copied union
    // arriving by the back door.
    for (const file of ENGINE_FILES.slice(1)) {
      const source = readFileSync(file, "utf8");
      expect(source.toLowerCase(), file).not.toContain("tally");
      expect(source, file).not.toContain("media.asset");
      expect(source, file).not.toContain("core.document");
    }
  });

  it("Tally's own call sites pass nothing the engine had to learn", () => {
    // Web: an itemType from the registry and an id. Native: the same, plus
    // the caller's own noun for the status line — copy, not behaviour.
    const web = readFileSync(
      path.join(APPS_DIR, "tally", "components", "GroupManager.tsx"),
      "utf8"
    );
    expect(web).toContain('itemType="tally.group"');
    expect(web).toContain("ShareSheet");
    const native = readFileSync(
      path.resolve(
        PACKAGE_ROOT,
        "../../apps/mobile/src/apps/tally/TallyHome.tsx"
      ),
      "utf8"
    );
    expect(native).toContain('itemType="tally.group"');
    expect(native).toContain("ShareSheet");
  });

  it("record-only Tally reaches placement without touching custody", () => {
    // The two engines are independent by construction: being "born shared"
    // (engine A) says nothing about carrying bytes (engine B). Tally is the
    // app that proves the split, and `blueprint-seats.test.ts` already gates
    // the custody half — this only pins that placement did not drag any of it
    // in through the back door.
    const dir = path.join(APPS_DIR, "tally");
    for (const file of sourceFiles(dir)) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toContain("kit/transfer");
      expect(text, file).not.toContain("custody_rollup");
    }
  });
});

describe("Docs shares its actual folder container", () => {
  // The native half of this pair asserted the same two facts about
  // `apps/mobile/src/apps/docs/DocsHome.tsx` until that screen was removed
  // pending its v11 design handoff. It is dropped rather than softened to a
  // conditional read: a test that skips itself when its subject is missing
  // passes for the wrong reason, and would go on passing if the rebuilt drive
  // shared the wrong container. Restore it with the screen.
  it("web passes docs.folder plus the selected folder id", () => {
    const web = readFileSync(
      path.join(APPS_DIR, "docs", "app-root.tsx"),
      "utf8"
    );
    expect(web).toContain('itemType="docs.folder"');
    expect(web).toContain("shareFolder.folder_id");
  });
});

describe("native Photos selection reaches Commons with explicit items", () => {
  it("passes media asset ids and has no retired giveMany override", () => {
    const source = readFileSync(
      path.resolve(
        PACKAGE_ROOT,
        "../../apps/mobile/src/apps/photos/use-copy-to-vault.ts"
      ),
      "utf8"
    );
    expect(source).toContain('itemType: "media.asset"');
    expect(source).toContain("itemIds: targets.map((asset) => asset.assetId)");
    expect(source).not.toContain("giveMany");
  });

  it("does not originate an album Commons declaration, but can retain a received album", () => {
    const nativeAlbum = readFileSync(
      path.resolve(
        PACKAGE_ROOT,
        "../../apps/mobile/src/apps/photos/AlbumDetail.tsx"
      ),
      "utf8"
    );
    expect(nativeAlbum).not.toContain('itemType="core.collection"');
    expect(nativeAlbum).not.toContain("Share album with household");
    expect(nativeAlbum).toContain('itemType: "core.collection"');
    expect(nativeAlbum).toContain("Save to my vault");
    expect(nativeAlbum).toContain("copyToVault.sheetProps");

    const webAlbumOrigin = sourceFiles(path.join(APPS_DIR, "photos")).filter(
      (file) =>
        /itemType\s*=\s*["']core\.collection["']/u.test(
          readFileSync(file, "utf8")
        )
    );
    expect(webAlbumOrigin).toStrictEqual([]);
  });
});

describe("unjoined Commons invitations have a complete sender/receiver handoff", () => {
  it("web and native consume returned claims and expose deliberate copy/share actions", () => {
    const web = readFileSync(
      path.join(APPS_DIR, "_shared", "ShareSheet.tsx"),
      "utf8"
    );
    const native = readFileSync(
      path.resolve(
        PACKAGE_ROOT,
        "../../apps/mobile/src/kit/share/ShareSheet.tsx"
      ),
      "utf8"
    );
    expect(web).toContain("result.claims");
    expect(web).toContain("Copy invite");
    expect(web).toContain("Share invite");
    expect(native).toContain("result.claims");
    expect(native).toContain("Clipboard.setStringAsync");
    expect(native).toContain("Share.share");
  });

  it("web and native receiver surfaces parse, redeem, and immediately clear the raw code", () => {
    const web = readFileSync(
      path.resolve(PACKAGE_ROOT, "../client/src/react/screens/SharingCard.tsx"),
      "utf8"
    );
    const native = readFileSync(
      path.resolve(PACKAGE_ROOT, "../../apps/mobile/src/screens/Sharing.tsx"),
      "utf8"
    );
    for (const source of [web, native]) {
      expect(source).toContain("parseCommonsInvite");
      expect(source).toContain('setCommonsInviteCode("")');
    }
    expect(web).toContain("onClaimCommonsInvitation");
    expect(native).toContain("claimCommonsInvitation");
  });
});

describe("named-circle reuse stays exact", () => {
  it("web and native detach circleId on every individual roster/capability edit", () => {
    const web = readFileSync(
      path.join(APPS_DIR, "_shared", "ShareSheet.tsx"),
      "utf8"
    );
    const native = readFileSync(
      path.resolve(
        PACKAGE_ROOT,
        "../../apps/mobile/src/kit/share/ShareSheet.tsx"
      ),
      "utf8"
    );
    for (const source of [web, native]) {
      expect(source).toContain("manualShareSelection");
      expect(source).toContain("setSelectedCircleId(next.circleId)");
      expect(source).toContain("Named group ·");
    }
  });
});

describe("Save to my vault is gated by exact Commons residency", () => {
  it("web and native detect lineage, retain it, and never infer from personal scope", () => {
    const files = [
      path.join(APPS_DIR, "photos", "components", "Lightbox.tsx"),
      path.join(APPS_DIR, "docs", "components", "Details.tsx"),
      path.join(APPS_DIR, "docs", "app-root.tsx"),
      path.resolve(
        PACKAGE_ROOT,
        "../../apps/mobile/src/apps/photos/PhotoLightbox.tsx"
      ),
      path.resolve(
        PACKAGE_ROOT,
        "../../apps/mobile/src/apps/photos/AlbumDetail.tsx"
      ),
      // The two native Docs surfaces (DocumentViewer.tsx, DocsHome.tsx) were in
      // this list until they were removed pending the v11 design handoff. The
      // rebuilt drive must rejoin it: the exact-residency gate is what stops
      // "Save to my vault" appearing over an item that was never in Commons.
    ];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file).toMatch(
        /(?:commonsResidents|listCommonsResidents)/u
      );
      expect(source, file).toContain("retainCommonsItem");
      expect(source, file).not.toContain("personal === false");
    }
    const exactGestureSources = [
      ...files,
      path.resolve(
        PACKAGE_ROOT,
        "../../apps/mobile/src/apps/photos/PhotoLightboxToolbar.tsx"
      ),
    ].map((file) => readFileSync(file, "utf8"));
    expect(exactGestureSources.join("\n")).toContain("Save to my vault");
  });
});
