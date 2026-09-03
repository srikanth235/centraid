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
  path.resolve(import.meta.dirname, "../apps/_shared/scope-kit.ts")
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
describe("scope-kit suite", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  describe("mounted scopes (#599, #726)", () => {
    it("treats a host with no scopes as one unnamed, writable scope", () => {
      mount(undefined, { readAll: false });
      const scopes = scopesModule.mountedScopes();
      expect(scopes).toHaveLength(1);
      expect(scopesModule.ownScopeId(scopes)).toBe("");
      expect(
        scopesModule.scopeAttr(scopesModule.ownScopeId(scopes))
      ).toBeUndefined();
    });

    it("disables the write target on a read-only audience, naming it", () => {
      mount([own, family, club]);
      const target = scopesModule.photoWriteTarget("new", "club");
      expect(target.disabled).toBe(true);
      expect((target as { reason: string }).reason).toBe(
        "Book Club is read-only here."
      );
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
      expect(scopesModule.photoWriteTarget("new", null)).toStrictEqual({
        disabled: false,
        scopeId: "own",
        label: "Library",
      });
    });

    it("keeps own-scope surfaces on the own scope whatever the chip says", () => {
      mount([own, family, club]);
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
