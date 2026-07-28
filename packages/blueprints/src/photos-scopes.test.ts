// What Photos asks about its mounted scopes (issue #599, apps/photos/scopes.ts).
// The rule itself is proved in write-target.test.ts; what matters here is that
// the app applies it to the right question — in particular that looking at a
// read-only audience yields a DISABLED target with a reason, so the control is
// greyed out rather than firing a write the shell would refuse.
//
// The module reads `window.centraid` live (audiences hydrate after first
// paint), so each case installs its own window stub before importing.
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

interface Scope {
  id: string;
  label: string;
  canWrite: boolean;
}
type WriteTarget =
  | { disabled: false; scopeId: string; label: string }
  | { disabled: true; reason: string };

const moduleUrl = pathToFileURL(
  path.resolve(import.meta.dirname, "../apps/photos/scopes.ts")
).href;
const scopesModule = (await import(moduleUrl)) as {
  mountedScopes: () => Scope[];
  ownScopeId: (scopes?: readonly Scope[]) => string;
  canWriteScope: (scopeId: string | null | undefined) => boolean;
  photoWriteTarget: (
    kind: "new" | "own",
    selectedScopeId: string | null,
    scopes?: readonly Scope[]
  ) => WriteTarget;
  scopeAttr: (scopeId: string | null | undefined) => string | undefined;
};

const own: Scope = { id: "own", label: "Library", canWrite: true };
const family: Scope = { id: "family", label: "Family", canWrite: true };
const club: Scope = { id: "club", label: "Book Club", canWrite: false };

/** Install a `window.centraid` with the given scopes (and a multi-scope door). */
function mount(
  scopes: Scope[] | undefined,
  { readAll = true }: { readAll?: boolean } = {}
): void {
  (globalThis as { window?: unknown }).window = {
    centraid: {
      ...(scopes ? { scopes } : {}),
      ...(readAll ? { readAll: () => Promise.resolve([]) } : {}),
    },
  };
}
describe("photos-scopes suite", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  describe("Photos scopes (#599)", () => {
    it("treats a host with no scopes as one unnamed, writable scope", () => {
      mount(undefined, { readAll: false });
      const scopes = scopesModule.mountedScopes();
      expect(scopes).toHaveLength(1);
      expect(scopesModule.ownScopeId(scopes)).toBe("");
      // An empty id is never stamped, so a solo member's markup is unchanged.
      expect(
        scopesModule.scopeAttr(scopesModule.ownScopeId(scopes))
      ).toBeUndefined();
    });

    it("disables the write target on a read-only audience, naming it", () => {
      mount([own, family, club]);
      const target = scopesModule.photoWriteTarget("new", "club");
      expect(target.disabled).toBe(true);
      expect((target as { reason: string }).reason).toBe(
        "You can view Book Club but not add to it."
      );
      // Same answer through the per-scope question the tile controls ask.
      expect(scopesModule.canWriteScope("club")).toBe(false);
      expect(scopesModule.canWriteScope("family")).toBe(true);
    });

    it("sends new things to the audience the member is looking at", () => {
      mount([own, family, club]);
      expect(scopesModule.photoWriteTarget("new", "family")).toStrictEqual({
        disabled: false,
        scopeId: "family",
        label: "Family",
      });
      // "All" is a reading lens, never a writing one.
      expect(scopesModule.photoWriteTarget("new", null)).toStrictEqual({
        disabled: false,
        scopeId: "own",
        label: "Library",
      });
    });

    it("keeps own-scope surfaces on the own scope whatever the chip says", () => {
      mount([own, family, club]);
      // Albums, tags and places resolve as `own`, so selecting a read-only
      // audience never disables making an album in the member's own space.
      for (const selected of [null, "family", "club"]) {
        expect(scopesModule.photoWriteTarget("own", selected)).toStrictEqual({
          disabled: false,
          scopeId: "own",
          label: "Library",
        });
      }
    });

    it("lets the shell answer for a scope it does not know", () => {
      mount([own, family]);
      expect(scopesModule.canWriteScope("gone")).toBe(true);
    });
  });
});
