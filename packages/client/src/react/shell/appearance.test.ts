import { darkTheme } from "@centraid/design-tokens";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ACCENT_PALETTE } from "../../app-shell-context.js";
import {
  applyPrefsToDocument,
  DEFAULT_PREFS,
  pickAppearance,
  resolveBgL,
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
      density: "comfy",
      cards: "elevated",
      // Retired in #608 — a gateway still holding one must not resurrect it.
      surfaceTemp: "warm",
      accentKey: "rose",
      bogus: "nope",
      density2: "x",
    });
    expect(got).toStrictEqual({
      theme: "dark",
      themeMode: "dark",
      density: "comfy",
      cardVariant: "elevated",
      accent: "rose",
    });
  });

  it("rejects invalid union values", () => {
    expect(
      pickAppearance({
        density: "huge",
        cards: "shiny",
        accentKey: "chartreuse",
      })
    ).toStrictEqual({});
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

  it("falls back to the legacy `accent` key when `accentKey` is absent", () => {
    expect(pickAppearance({ accent: "teal" })).toStrictEqual({
      accent: "teal",
    });
  });

  it("emits both the accent key and its resolved swatches to the wire", () => {
    const wire = toRemoteShape({ accent: "violet" });
    expect(wire.accentKey).toBe("violet");
    expect(wire.accent).toBe(ACCENT_PALETTE.violet.accent);
    expect(wire.accentLight).toBe(ACCENT_PALETTE.violet.light);
    expect(wire.accentDeep).toBe(ACCENT_PALETTE.violet.deep);
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
      density: DEFAULT_PREFS.density,
      cardVariant: DEFAULT_PREFS.cardVariant,
    });
  });

  it("writes prefs onto <html> as data-attrs", () => {
    applyPrefsToDocument({
      ...DEFAULT_PREFS,
      theme: "light",
      themeMode: "light",
      density: "compact",
    });
    const html = document.documentElement;
    expect(html.dataset.theme).toBe("light");
    expect(html.dataset.density).toBe("compact");
    // Dark has exactly one ramp now, so nothing writes a surface temperature.
    expect(html.dataset.surfaceTemp).toBeUndefined();
  });

  describe("theme values are the floor", () => {
    // #608 P — inline styles on <html> outrank every [data-theme='…'] block,
    // so writing the pref layer's accent and lightness unconditionally meant a
    // theme's own values could never render.
    it("writes no inline accent or lightness without an explicit override", () => {
      applyPrefsToDocument(DEFAULT_PREFS);
      const s = document.documentElement.style;
      expect(s.getPropertyValue("--accent")).toBe("");
      expect(s.getPropertyValue("--accent-light")).toBe("");
      expect(s.getPropertyValue("--accent-deep")).toBe("");
      expect(s.getPropertyValue("--bg-l")).toBe("");
    });

    it("writes them once the owner picks, and clears them when they unpick", () => {
      applyPrefsToDocument({ ...DEFAULT_PREFS, accent: "ochre", bgL: 5 });
      const s = document.documentElement.style;
      expect(s.getPropertyValue("--accent")).toBe(ACCENT_PALETTE.ochre.accent);
      expect(s.getPropertyValue("--bg-l")).toBe("5%");
      // Clearing matters as much as setting: a stale inline value would keep
      // outranking the theme block forever.
      applyPrefsToDocument(DEFAULT_PREFS);
      expect(s.getPropertyValue("--accent")).toBe("");
      expect(s.getPropertyValue("--bg-l")).toBe("");
    });

    it("resolves the lightness anchor from the theme unless overridden", () => {
      // The ramp runs at what darkTheme declares. The anchor is the shipped
      // near-black, and it lives in the theme now rather than in a pref
      // default that outranked the theme inline.
      expect(darkTheme.bgL).toBe("5%");
      expect(resolveBgL(DEFAULT_PREFS)).toBe(5);
      expect(resolveBgL({ ...DEFAULT_PREFS, bgL: 22 })).toBe(22);
      // Light themes declare no anchor; the blueprint dark default stands in.
      expect(
        resolveBgL({ ...DEFAULT_PREFS, theme: "light", themeMode: "light" })
      ).toBe(10);
    });
  });
});
