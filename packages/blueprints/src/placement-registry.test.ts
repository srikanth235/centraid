/*
 * A4/A7 tripwires for `apps/_shared/placement-registry.ts` (#712). A4:
 * `PlaceableItemType` stays vault's `ShareableItemType` minus `"locker.item"`;
 * blueprints cannot import `@centraid/vault`, so this source-scans
 * `closure.ts`. A7: Locker is structurally excluded from sharing.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

// Browser ES modules outside this TS program, so the shape is local.
interface PlacementEntity {
  itemType: string;
  appId: string;
  label: string;
}
const registryModuleUrl = pathToFileURL(
  path.resolve(import.meta.dirname, "../apps/_shared/placement-registry.ts")
).href;
const { PLACEMENT_REGISTRY } = (await import(registryModuleUrl)) as {
  PLACEMENT_REGISTRY: readonly PlacementEntity[];
};

const placeableItemTypes = PLACEMENT_REGISTRY.map((entity) => entity.itemType);

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const CLOSURE_PATH = path.resolve(
  PACKAGE_ROOT,
  "../vault/src/share/closure.ts"
);
const APPS_DIR = path.join(PACKAGE_ROOT, "apps");

/** A source scan, not an import — see the header. */
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
    // If vault drops locker.item, A7 is moot: revisit, never pass silently.
    expect(vaultTypes).toContain("locker.item");
  });

  it("the registry is exactly vault's list minus locker.item", () => {
    const expected = vaultTypes.filter((t) => t !== "locker.item").toSorted();
    expect([...placeableItemTypes].toSorted()).toStrictEqual(expected);
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
    expect(placeableItemTypes).not.toContain("locker.item");
  });

  it("no bundled app source passes locker.item as a placement itemType", () => {
    const offenders = sourceFiles(APPS_DIR).filter((file) =>
      /itemType\s*[:=]\s*["']locker\.item["']/u.test(readFileSync(file, "utf8"))
    );
    expect(offenders).toStrictEqual([]);
  });
});

/*
 * A6. Tally is "born shared", so it tests whether engine A is an ENGINE or
 * Photos' sharing code with a wider type: any edit Tally needs is an ENGINE
 * DEFECT, not a Tally patch.
 */
describe("Tally consumes the placement engine with zero engine edits (A6)", () => {
  const ENGINE_FILES = [
    path.join(APPS_DIR, "_shared", "placement-registry.ts"),
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
    // Only RENDERERS are held to this; a registry names apps by definition.
    for (const file of ENGINE_FILES.slice(1)) {
      const source = readFileSync(file, "utf8");
      expect(source.toLowerCase(), file).not.toContain("tally");
      expect(source, file).not.toContain("media.asset");
      expect(source, file).not.toContain("core.document");
    }
  });

  it("record-only Tally reaches placement without touching custody", () => {
    // Being "born shared" says nothing about carrying bytes.
    const dir = path.join(APPS_DIR, "tally");
    for (const file of sourceFiles(dir)) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toContain("kit/transfer");
      expect(text, file).not.toContain("custody_rollup");
    }
  });
});

describe("Docs shares its actual folder container", () => {
  // A shared folder is ONE standing grant over `docs.folder`, never a batch
  // of placed item ids (#825). Restore the native half with its screen.
  it("web shares the selected folder as one docs.folder grant", () => {
    const web = readFileSync(
      path.join(APPS_DIR, "docs", "app-root.tsx"),
      "utf8"
    );
    expect(web).toContain('subjectType: "docs.folder"');
    expect(web).toContain("shareFolder.folder_id");
    // No app-private share plumbing survives anywhere in Docs.
    for (const file of sourceFiles(path.join(APPS_DIR, "docs"))) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toContain("ShareSheet");
      expect(text, file).not.toContain("window.centraid.share");
    }
  });

  it("native shares the folder it is standing in as the same subject", () => {
    const native = readFileSync(
      path.resolve(
        PACKAGE_ROOT,
        "../../apps/mobile/src/apps/docs/FolderView.tsx"
      ),
      "utf8"
    );
    expect(native).toContain('subjectType: "docs.folder"');
    expect(native).not.toContain("ShareSheet");
  });
});

// A share is a standing grant over ONE declared subject (#825); retaining is
// not sharing and stays on the Commons plane.
describe("native Photos selection reaches the grant plane by subject", () => {
  it("shares the selected photograph as one media.asset grant", () => {
    const source = readFileSync(
      path.resolve(
        PACKAGE_ROOT,
        "../../apps/mobile/src/apps/photos/use-photo-selection-share.ts"
      ),
      "utf8"
    );
    expect(source).toContain('subjectType: "media.asset"');
    expect(source).not.toContain("giveMany");
    expect(source).not.toContain("session.share");
    expect(source).not.toContain("itemIds");
  });

  it("shares an album as core.collection, and still retains a received album", () => {
    const nativeAlbum = readFileSync(
      path.resolve(
        PACKAGE_ROOT,
        "../../apps/mobile/src/apps/photos/AlbumDetail.tsx"
      ),
      "utf8"
    );
    expect(nativeAlbum).not.toContain('itemType="core.collection"');
    expect(nativeAlbum).not.toContain("Share album with household");
    expect(nativeAlbum).toContain('subjectType: "core.collection"');
    expect(nativeAlbum).toContain('itemType: "core.collection"');
    expect(nativeAlbum).toContain("Save to my vault");

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
  it("the sender surface consumes returned claims and offers deliberate copy/share actions", () => {
    const native = readFileSync(
      path.resolve(
        PACKAGE_ROOT,
        "../../apps/mobile/src/kit/share/ShareSheet.tsx"
      ),
      "utf8"
    );
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
  it("the share sheet detaches circleId on every individual roster/capability edit", () => {
    const native = readFileSync(
      path.resolve(
        PACKAGE_ROOT,
        "../../apps/mobile/src/kit/share/ShareSheet.tsx"
      ),
      "utf8"
    );
    expect(native).toContain("manualShareSelection");
    expect(native).toContain("setSelectedCircleId(next.circleId)");
    expect(native).toContain("Named group ·");
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
      // The rebuilt Docs surfaces must rejoin this list: the exact-residency
      // gate is what keeps "Save to my vault" off a non-Commons item.
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
