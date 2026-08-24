// Cross-scope asset identity in Photos (#599, apps/photos/asset-key.ts).
//
// `asset_id` is minted per vault, so two mounted scopes can legitimately carry
// the SAME id for two unrelated photos. Everything in the UI that means "this
// exact row" — the selection set, the lightbox lookup, a batch command's
// target — therefore keys on the pair `(scope_id, asset_id)`. These tests use a
// deliberately colliding id and prove that a command aimed at one scope touches
// ONLY that scope.
//
// LAYOUT NOTE. These modules are unit-testable without a booted app, so the
// real sources are copied into a temp dir beside two stubs and imported from
// there; shared pure helpers keep their production-relative path under
// `_shared/`. The modules UNDER TEST are byte-identical apart from ONE
// rewritten specifier, so this is still testing the real code — only the two
// effect boundaries are replaced.
//
// The design package's element layer is stubbed rather than loaded because
// importing it defines custom elements, which needs a DOM this node-side suite
// has no reason to boot. It cannot be `vi.mock`ed: the copies are loaded by
// native `import()` from outside the project root (vite refuses a module
// there), which never reaches vitest's module registry.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { beforeEach, describe, expect, it } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

interface ActCall {
  action: string;
  input: Record<string, unknown>;
  scope: string | null | undefined;
}

interface PhotosAsset {
  asset_id: string;
  content_id: string;
  scope_id?: string | null;
  title?: string | null;
  taken_at?: string | null;
  [key: string]: unknown;
}

// The loaded modules' surfaces, declared locally: a `typeof import(...)` of an
// app file would pull `apps/` into this package's `src`-rooted program (the
// same reason photos-library-store.test.ts declares its own `Store`).
interface AssetKeyModule {
  assetKey: (asset: { asset_id: string; scope_id?: string | null }) => string;
  assetRefKey: (scopeId: string | null | undefined, assetId: string) => string;
  parseAssetKey: (key: string) => { scopeId: string; assetId: string };
  scopeOfKey: (key: string) => string | null;
}
interface VisibilityModule {
  createVisibility: (getters: {
    getAssets: () => PhotosAsset[];
    getTrash: () => PhotosAsset[];
    getAlbumAssets: () => PhotosAsset[];
    getSearchResults: () => PhotosAsset[] | null;
    getSearchQuery: () => string;
    getSelectedAlbum: () => string | null;
  }) => {
    visibleAssets: () => PhotosAsset[];
    findAsset: (key: string) => PhotosAsset | undefined;
  };
}
interface BatchCallbacks {
  refresh: () => Promise<void>;
  setBarBusy: (on: boolean) => void;
  exitSelectMode: () => void;
}
interface SelectionActionsModule {
  runBatchDelete: (
    keys: string[],
    progressEl: HTMLElement | null,
    callbacks: BatchCallbacks
  ) => Promise<void>;
  runBatchRestore: (
    keys: string[],
    callbacks: Pick<BatchCallbacks, "refresh">
  ) => Promise<void>;
}

const PHOTOS = path.resolve(import.meta.dirname, "../apps/photos");
const COPIED = [
  "asset-key.ts",
  "constants.ts",
  "format.ts",
  "types.ts",
  "visibility.ts",
  "selection-actions.ts",
];

const ELEMENTS = "@centraid/design/elements";

const root = tempDirSync("photos-asset-key-");
const dir = path.join(root, "photos");
mkdirSync(dir, { recursive: true });
for (const file of COPIED) {
  writeFileSync(
    path.join(dir, file),
    readFileSync(path.join(PHOTOS, file), "utf8").replaceAll(
      `"${ELEMENTS}"`,
      '"./elements-stub.ts"'
    )
  );
}
mkdirSync(path.join(root, "_shared"), { recursive: true });
copyFileSync(
  path.resolve(PHOTOS, "../_shared/selection-engine.ts"),
  path.join(root, "_shared/selection-engine.ts")
);

// The element surface these two modules actually touch. `format.ts` wants two
// formatting helpers; `selection-actions.ts` wants `statusLine`.
writeFileSync(
  path.join(dir, "elements-stub.ts"),
  `export const fmtBytes = (n: number): string => String(n);
export const localDayKey = (at: string | Date): string =>
  (at instanceof Date ? at.toISOString() : String(at)).slice(0, 10);
export const statusLine = (): void => undefined;
`
);

// The command boundary, recording instead of dispatching. Every assertion below
// is about WHAT the real batch code asked for and IN WHICH SCOPE.
writeFileSync(
  path.join(dir, "outcomes.ts"),
  `const sink = globalThis as unknown as { __photosActs: unknown[] };
sink.__photosActs = sink.__photosActs ?? [];
export const act = (action: string, input: unknown, scope?: string | null) => {
  sink.__photosActs.push({ action, input, scope });
  return Promise.resolve({ status: 'executed' });
};
export const narrate = (): boolean => false;
export const notice = (): void => undefined;
export const writeTarget = () => ({ disabled: false, scopeId: 'vault-own', label: 'Library' });
`
);

const load = <T>(file: string): Promise<T> =>
  import(pathToFileURL(path.join(dir, file)).href) as Promise<T>;

const { assetKey, assetRefKey, parseAssetKey, scopeOfKey } =
  await load<AssetKeyModule>("asset-key.ts");
const { createVisibility } = await load<VisibilityModule>("visibility.ts");
const { runBatchDelete, runBatchRestore } = await load<SelectionActionsModule>(
  "selection-actions.ts"
);

const acts = (globalThis as unknown as { __photosActs: ActCall[] })
  .__photosActs;
describe("photos-asset-key suite", () => {
  /** THE collision: one id, two scopes, two entirely different photos. */
  const COLLIDING = "asset-1";
  const ownRow: PhotosAsset = {
    asset_id: COLLIDING,
    content_id: "c-own",
    scope_id: "vault-own",
    title: "My birthday",
    taken_at: "2026-05-01T10:00:00Z",
  };
  const familyRow: PhotosAsset = {
    asset_id: COLLIDING,
    content_id: "c-family",
    scope_id: "vault-family",
    title: "Reunion",
    taken_at: "2026-04-01T10:00:00Z",
  };
  const rows = [ownRow, familyRow];

  function visibility() {
    return createVisibility({
      getAssets: () => rows,
      getTrash: () => [],
      getAlbumAssets: () => rows,
      getSearchResults: () => null,
      getSearchQuery: () => "",
      getSelectedAlbum: () => null,
    });
  }

  const noopBatch = {
    refresh: () => Promise.resolve(),
    setBarBusy: () => undefined,
    exitSelectMode: () => undefined,
  };
  const progress = { textContent: "" } as unknown as HTMLElement;

  beforeEach(() => {
    acts.length = 0;
  });

  describe("assetKey", () => {
    it("separates two scopes carrying the same asset id", () => {
      expect(assetKey(ownRow)).not.toBe(assetKey(familyRow));
    });

    it("round-trips through parseAssetKey", () => {
      expect(parseAssetKey(assetKey(familyRow))).toStrictEqual({
        scopeId: "vault-family",
        assetId: COLLIDING,
      });
    });

    it("treats the solo scope as ambient, so a single-scope mount is unchanged", () => {
      const solo = assetRefKey("", "asset-9");
      expect(parseAssetKey(solo)).toStrictEqual({
        scopeId: "",
        assetId: "asset-9",
      });
      expect(scopeOfKey(solo)).toBeNull();
      expect(scopeOfKey(assetKey(familyRow))).toBe("vault-family");
    });

    it("reads a bare asset id as the ambient scope rather than throwing", () => {
      expect(parseAssetKey("asset-9")).toStrictEqual({
        scopeId: "",
        assetId: "asset-9",
      });
    });
  });

  describe("findAsset", () => {
    it("resolves a colliding id to the scope that was asked for", () => {
      const { findAsset } = visibility();
      expect(findAsset(assetKey(familyRow))?.content_id).toBe("c-family");
      expect(findAsset(assetKey(ownRow))?.content_id).toBe("c-own");
    });

    it("does not match a row from another scope with the same id", () => {
      const { findAsset } = visibility();
      expect(
        findAsset(assetRefKey("vault-grandma", COLLIDING))
      ).toBeUndefined();
    });
  });

  describe("visibleAssets", () => {
    it("keeps both colliding rows instead of collapsing them into one tile", () => {
      const shown = visibility().visibleAssets();
      expect(shown).toHaveLength(2);
      expect(shown.map((a) => a.content_id).sort()).toStrictEqual([
        "c-family",
        "c-own",
      ]);
    });
  });

  describe("batch commands", () => {
    it("deletes only the scope named in the key, never its colliding twin", async () => {
      await runBatchDelete([assetKey(familyRow)], progress, noopBatch);
      expect(acts).toStrictEqual([
        {
          action: "delete-asset",
          input: { asset_id: COLLIDING },
          scope: "vault-family",
        },
      ]);
    });

    it("addresses each key at its own scope across a mixed selection", async () => {
      await runBatchDelete(
        [assetKey(ownRow), assetKey(familyRow)],
        progress,
        noopBatch
      );
      expect(acts.map((call) => call.scope)).toStrictEqual([
        "vault-own",
        "vault-family",
      ]);
      // The payload still carries the BARE id: a vault only ever sees ids from
      // its own scope, so the pairing is a client-side identity, not wire shape.
      expect(new Set(acts.map((call) => call.input.asset_id))).toStrictEqual(
        new Set([COLLIDING])
      );
    });

    it("restores into the scope the row was trashed from", async () => {
      await runBatchRestore([assetKey(familyRow)], {
        refresh: () => Promise.resolve(),
      });
      expect(acts).toStrictEqual([
        {
          action: "restore",
          input: { asset_id: COLLIDING },
          scope: "vault-family",
        },
      ]);
    });

    it("addresses a solo-scope key at the ambient scope", async () => {
      await runBatchDelete([assetRefKey("", COLLIDING)], progress, noopBatch);
      expect(acts).toStrictEqual([
        { action: "delete-asset", input: { asset_id: COLLIDING }, scope: null },
      ]);
    });
  });
});
