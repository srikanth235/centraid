import { afterEach, describe, expect, it, vi } from "vitest";

import { sectionsStartCollapsed } from "./vault-sections.js";

// Which of the Vault surface's three sections start closed (v11). The rule is
// the SURFACE axis — pointer or touch — and never a width.

describe("the Vault surface's disclosures", () => {
  const original = window.matchMedia;

  afterEach(() => {
    if (original) window.matchMedia = original;
    else Reflect.deleteProperty(window, "matchMedia");
    vi.restoreAllMocks();
  });

  const answer = (matches: boolean): void => {
    window.matchMedia = vi.fn<(query: string) => MediaQueryList>((query) => ({
      matches,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  };

  it("opens under a pointer and closes under a finger", () => {
    answer(true);
    expect(sectionsStartCollapsed()).toBe(false);
    answer(false);
    // On a phone "What it holds" alone is forty rows; opened, it would put the
    // section a member came for six screens down.
    expect(sectionsStartCollapsed()).toBe(true);
  });

  it("asks about the surface, never the width", () => {
    const asked: string[] = [];
    window.matchMedia = ((query: string) => {
      asked.push(query);
      return { matches: true };
    }) as unknown as typeof window.matchMedia;
    sectionsStartCollapsed();
    // Surface is the one fixed row in DESIGN.md's freedom table and it has
    // exactly one axis. A narrow window on a laptop is a canvas, not a second
    // surface, so a width query here would be a third set of values.
    expect(asked).toStrictEqual(["(pointer: fine)"]);
  });

  it("opens when it cannot ask at all", () => {
    // No `matchMedia` — SSR, jsdom, an old engine. A page that defaulted to
    // closed here would hide its whole body from every reader it failed to
    // measure, and an open section is recoverable by one press.
    Reflect.deleteProperty(window, "matchMedia");
    expect(sectionsStartCollapsed()).toBe(false);
    window.matchMedia = (() => {
      throw new Error("unsupported query");
    }) as unknown as typeof window.matchMedia;
    expect(sectionsStartCollapsed()).toBe(false);
  });
});
