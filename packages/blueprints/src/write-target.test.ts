// The multi-scope write rule (#599, apps/_shared/write-target.ts): where
// a new item lands when an app is mounted over several scopes at once. Every
// branch of the rule is pinned here, including the two degenerate inputs that
// keep the function total.
//
// The module is loaded by file URL (the blueprint apps are browser ES modules
// outside this package's TS program — the same trick docs-media.test.ts uses),
// so the shapes it returns are declared locally.
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

interface Scope {
  id: string;
  label: string;
  canWrite: boolean;
}
type WriteTarget =
  | { disabled: false; scopeId: string; label: string }
  | { disabled: true; reason: string };

const moduleUrl = pathToFileURL(
  path.resolve(import.meta.dirname, "../apps/_shared/write-target.ts")
).href;
const { resolveWriteTarget } = (await import(moduleUrl)) as {
  resolveWriteTarget: (input: {
    scopes: readonly Scope[];
    ownScopeId: string;
    selectedScopeId: string | null;
  }) => WriteTarget;
};

const own: Scope = { id: "own", label: "Library", canWrite: true };
const family: Scope = { id: "family", label: "Family", canWrite: true };
const readOnly: Scope = { id: "club", label: "Book Club", canWrite: false };
const scopes = [own, family, readOnly];

const resolve = (
  selectedScopeId: string | null,
  list: readonly Scope[] = scopes
) => resolveWriteTarget({ scopes: list, ownScopeId: "own", selectedScopeId });

describe("resolveWriteTarget (#599)", () => {
  it('sends an "All" selection to the member’s own scope', () => {
    expect(resolve(null)).toStrictEqual({
      disabled: false,
      scopeId: "own",
      label: "Library",
    });
  });

  it("sends the own chip to the own scope", () => {
    expect(resolve("own")).toStrictEqual({
      disabled: false,
      scopeId: "own",
      label: "Library",
    });
  });

  it("sends a writable audience chip to that audience", () => {
    expect(resolve("family")).toStrictEqual({
      disabled: false,
      scopeId: "family",
      label: "Family",
    });
  });

  it("blocks a read-only audience and names it in the reason", () => {
    const target = resolve("club");
    expect(target.disabled).toBe(true);
    expect((target as { reason: string }).reason).toBe(
      "Book Club is read-only here."
    );
  });

  it("blocks a selection naming a scope that is no longer mounted", () => {
    const target = resolve("gone");
    expect(target).toStrictEqual({
      disabled: true,
      reason: "That space isn’t open right now.",
    });
  });

  it('blocks "All" when the own scope is not among the mounted scopes', () => {
    const target = resolveWriteTarget({
      scopes: [family],
      ownScopeId: "own",
      selectedScopeId: null,
    });
    expect(target).toStrictEqual({
      disabled: true,
      reason: "Your own space isn’t open right now.",
    });
  });

  it("blocks the own scope when it is itself read-only", () => {
    const frozen = [{ id: "own", label: "Library", canWrite: false }, family];
    expect(resolve("own", frozen)).toStrictEqual({
      disabled: true,
      reason: "Library is read-only for now.",
    });
    // "All" resolves through the same branch, so it is blocked identically.
    expect(resolve(null, frozen)).toStrictEqual(resolve("own", frozen));
  });

  it('never says "vault" in a reason a user reads', () => {
    const reasons = [resolve("club"), resolve("gone"), resolve(null, [family])]
      .filter((t): t is { disabled: true; reason: string } => t.disabled)
      .map((t) => t.reason);
    expect(reasons).toHaveLength(3);
    for (const reason of reasons) expect(reason).not.toMatch(/\bvault\b/iu);
  });
});
