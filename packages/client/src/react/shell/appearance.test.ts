import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyPrefsToDocument,
  DEFAULT_PREFS,
  pickAppearance,
  resolveThemeMode,
  toRemoteShape,
} from "./appearance.js";

/** Force `prefers-color-scheme` for the `system` mode tests. */
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
      // Retired in #608 — a gateway still holding one must not resurrect it.
      surfaceTemp: "warm",
      // Retired in #707: the shell spends no hue, so an accent a previous
      // build stored is read as noise rather than resurrected as a pref.
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
    // #608 O — the twelve-preset registry was cut to two. A profile holding
    // `theme: 'monokai'` must degrade to DEFAULT_PREFS.theme with no error and
    // no migration step.
    expect(pickAppearance({ theme: "monokai" })).toStrictEqual({});
    expect(DEFAULT_PREFS.theme).toBe("dark");
    expect(DEFAULT_PREFS.themeMode).toBe("dark");
  });

  it("re-resolves the applied theme when the stored mode is `system`", () => {
    stubScheme(true);
    // The resolved `theme` it was saved with may be stale, so the mode wins.
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
    // Dark has exactly one ramp now, so nothing writes a surface temperature.
    expect(html.dataset.surfaceTemp).toBeUndefined();
  });

  describe("the theme block is the only colour authority", () => {
    // #608 P — inline styles on <html> outrank every [data-theme='…'] block,
    // so writing the pref layer's accent and lightness unconditionally meant a
    // theme's own values could never render. #707 removed both overrides
    // outright: applying prefs may not touch a single custom property.
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
