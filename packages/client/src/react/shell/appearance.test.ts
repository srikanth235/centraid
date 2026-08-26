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
      // Retired #608 / #707 — must read as noise, not resurrect as a pref.
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
    // #608 O — presets cut to two; degrade silently.
    expect(pickAppearance({ theme: "monokai" })).toStrictEqual({});
  });

  it("defaults to following the OS, not to dark", () => {
    // First run follows the OS; `dark` made light first run unreachable.
    expect(DEFAULT_PREFS.themeMode).toBe("system");
    // `theme` re-derived on mount/OS flip; no matchMedia → dark.
    expect(["light", "dark"]).toContain(DEFAULT_PREFS.theme);
  });

  it("re-resolves the applied theme when the stored mode is `system`", () => {
    stubScheme(true);
    // The saved `theme` may be stale; the mode wins.
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
    // Nothing writes a surface temperature.
    expect(html.dataset.surfaceTemp).toBeUndefined();
  });

  describe("the theme block is the only colour authority", () => {
    // #608 P / #707 — applying prefs may not touch a single custom property;
    // inline styles once outranked every theme block.
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
