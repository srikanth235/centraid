// EVERY SEARCH FIELD IS THE KIT'S (#1015, S4).
//
// The audit found eight hand-rolled search fields across nine surfaces, with
// three different keyboard contracts between them — a term that is silently
// auto-capitalised searches for something the member did not type, and Photos'
// had no `autoCapitalize` at all. `kit/components/SearchField` is the one
// field; this sweep is what stops a ninth from being typed.
//
// It is a SOURCE sweep rather than a render assertion because the thing being
// pinned is which component a surface reaches for, which no rendered tree can
// show once the raw field is gone.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SRC = path.join(__dirname, "..");

/**
 * The search surfaces in this seat. A new one belongs on this list; a raw
 * field on one of them is the failure this sweep exists to name.
 */
const SEARCH_SURFACES = [
  "apps/locker/LockerSearchView.tsx",
  "apps/people/PeopleHome.tsx",
  "apps/photos/PhotosSearch.tsx",
  "screens/home/AllAppsSheet.tsx",
  "screens/home/SearchOverlay.tsx",
] as const;

describe("search fields", () => {
  it.each(SEARCH_SURFACES)("%s reaches for the kit field", (relative) => {
    const source = readFileSync(path.join(SRC, relative), "utf8");
    // Either directly, or through the ROOM that hands it the field (#1015,
    // Wave 2): a surface inside `AppPlace`/`PushedPage` declares `search` as
    // a prop and the room mounts the one field, which is the same claim one
    // level up rather than a looser one.
    expect(
      /import SearchField from "[^"]*kit\/components\/SearchField";/u.test(
        source
      ) ||
        (/from "[^"]*kit\/rooms";/u.test(source) && /\bsearch=\{/u.test(source))
    ).toBe(true);
  });

  it.each(SEARCH_SURFACES)("%s hand-rolls no field of its own", (relative) => {
    const source = readFileSync(path.join(SRC, relative), "utf8");
    // A surface may still hold OTHER inputs (Photos' album rename, say) — but
    // none of these five do, so any `<TextInput` here is a search field that
    // slipped the kit.
    expect(source).not.toContain("<TextInput");
  });

  it("keeps the keyboard contract in one place", () => {
    // `autoCapitalize` / `autoCorrect` on a search surface means the contract
    // was re-typed instead of inherited.
    for (const relative of SEARCH_SURFACES) {
      const source = readFileSync(path.join(SRC, relative), "utf8");
      expect(source).not.toContain("autoCapitalize");
      expect(source).not.toContain("returnKeyType");
    }
  });
});
