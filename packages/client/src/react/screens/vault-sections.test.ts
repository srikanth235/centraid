import { afterEach, describe, expect, it, vi } from "vitest";

import { sectionsStartCollapsed } from "./vault-sections.js";

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
    expect(sectionsStartCollapsed()).toBe(true);
  });

  it("asks about the surface, never the width", () => {
    const asked: string[] = [];
    window.matchMedia = ((query: string) => {
      asked.push(query);
      return { matches: true };
    }) as unknown as typeof window.matchMedia;
    sectionsStartCollapsed();
    expect(asked).toStrictEqual(["(pointer: fine)"]);
  });

  it("opens when it cannot ask at all", () => {
    Reflect.deleteProperty(window, "matchMedia");
    expect(sectionsStartCollapsed()).toBe(false);
    window.matchMedia = (() => {
      throw new Error("unsupported query");
    }) as unknown as typeof window.matchMedia;
    expect(sectionsStartCollapsed()).toBe(false);
  });
});
