import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyPrefsToDocument,
  DEFAULT_PREFS,
  pickAppearance,
  resolveThemeMode,
  toRemoteShape,
} from "./appearance.js";

function stubScheme(light: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    (q: string) => ({ matches: light && q.includes("light") }) as MediaQueryList
  );
}

describe("appearance prefs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute("style");
  });

  it("picks only recognised keys off a remote object", () => {
    const got = pickAppearance({
      theme: "dark",
      cards: "elevated",
      surfaceTemp: "warm",
      accentKey: "rose",
      bgL: 22,
      bogus: "nope",
    });
    expect(got).toStrictEqual({
      theme: "dark",
      themeMode: "dark",
      cardVariant: "elevated",
    });
  });

  it("rejects invalid union values", () => {
    expect(pickAppearance({ cards: "shiny" })).toStrictEqual({});
  });

  it("drops a stored theme naming a preset this build no longer registers", () => {
    expect(pickAppearance({ theme: "monokai" })).toStrictEqual({});
  });

  it("defaults to following the OS, not to dark", () => {
    expect(DEFAULT_PREFS.themeMode).toBe("system");
    expect(["light", "dark"]).toContain(DEFAULT_PREFS.theme);
  });

  it("re-resolves the applied theme when the stored mode is `system`", () => {
    stubScheme(true);
    expect(
      pickAppearance({ themeMode: "system", theme: "dark" })
    ).toStrictEqual({ themeMode: "system", theme: "light" });
    stubScheme(false);
    expect(resolveThemeMode("system")).toBe("dark");
    expect(resolveThemeMode("light")).toBe("light");
  });

  it("maps cardVariant → cards on the wire", () => {
    expect(toRemoteShape({ cardVariant: "flat" })).toStrictEqual({
      cards: "flat",
    });
  });

  it("round-trips a full pref set through wire → pick", () => {
    const wire = toRemoteShape(DEFAULT_PREFS);
    const back = pickAppearance(wire);
    expect(back).toMatchObject({
      theme: DEFAULT_PREFS.theme,
      themeMode: DEFAULT_PREFS.themeMode,
      cardVariant: DEFAULT_PREFS.cardVariant,
    });
  });

  it("writes prefs onto <html> as data-attrs", () => {
    applyPrefsToDocument({
      ...DEFAULT_PREFS,
      theme: "light",
      themeMode: "light",
    });
    const html = document.documentElement;
    expect(html.dataset.theme).toBe("light");
    expect(html.dataset.surfaceTemp).toBeUndefined();
  });

  describe("the theme block is the only colour authority", () => {
    it("writes no inline colour of any kind", () => {
      applyPrefsToDocument({ ...DEFAULT_PREFS, theme: "light" });
      applyPrefsToDocument(DEFAULT_PREFS);
      const s = document.documentElement.style;
      for (const prop of [
        "--accent",
        "--accent-light",
        "--accent-deep",
        "--accent-text",
        "--accent-fill",
        "--accent-soft",
        "--bg-sel",
        "--line-sel",
        "--focus-ring-color",
        "--bg-l",
      ])
        expect(s.getPropertyValue(prop), prop).toBe("");
      expect(s).toHaveLength(0);
    });
  });
});
