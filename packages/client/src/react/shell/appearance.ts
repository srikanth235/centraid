// Appearance prefs — the renderer-owned theme/density/accent settings, ported
// out of the vanilla app.ts. Pure helpers here (validation + wire mapping +
// the document side-effect); the React hook that owns the live value and the
// gateway round-trip lives in useAppearance.ts.
//
// PRECEDENCE (#608 group P). `applyPrefsToDocument` writes inline styles on
// `<html>`, and an inline style outranks every `[data-theme='…']` block the
// token generator emits. So anything written here unconditionally overrides
// the theme that is supposedly being applied — which is why the dark ramp ran
// at the pref layer's anchor whatever `darkTheme` declared, and why a theme's
// own accent never rendered. A theme's values are the floor; `bgL` and `accent` go inline only
// when the owner has actually chosen one, and are cleared when they have not.
import { themes } from "@centraid/design-tokens";

import { ACCENT_PALETTE } from "../../app-shell-context.js";
import type {
  AccentKey,
  AppearancePrefs,
  ThemeMode,
  ThemeName,
} from "../../app-shell-context.js";

export const DEFAULT_PREFS: AppearancePrefs = {
  cardVariant: "outlined",
  density: "regular",
  sidebarOpen: true,
  theme: "dark",
  themeMode: "dark",
  tileVariant: "gradient",
};

/** The media query `system` mode tracks. Exported so the hook subscribes to
 *  the same one it resolves against. */
export const LIGHT_SCHEME_QUERY = "(prefers-color-scheme: light)";

/** Resolve a mode to the theme name to apply. `system` reads the OS. */
export function resolveThemeMode(mode: ThemeMode): ThemeName {
  if (mode !== "system") return mode;
  const mq =
    typeof matchMedia === "function" ? matchMedia(LIGHT_SCHEME_QUERY) : null;
  return mq?.matches ? "light" : "dark";
}

function isThemeMode(v: unknown): v is ThemeMode {
  return v === "system" || (typeof v === "string" && v in themes);
}

/** Fold an arbitrary remote prefs object onto the typed AppearancePrefs shape,
 *  dropping unknown keys and values that don't match the unions. Mirrors the
 *  gateway's KNOWN_KEYS list (vanilla `pickAppearance`).
 *
 *  A stored `theme` naming a preset this build no longer registers is simply
 *  dropped, so the client opens on DEFAULT_PREFS.theme — no migration step
 *  and no error path (#608 group O). */
export function pickAppearance(
  remote: Record<string, unknown>
): Partial<AppearancePrefs> {
  const out: Partial<AppearancePrefs> = {};
  // `themeMode` carries the intent; `theme` is the resolved name the gateway
  // bakes onto <html> for first paint. Accept either — a mode of `system`
  // wins, since the resolved value it was saved with may be stale.
  if (isThemeMode(remote.themeMode)) out.themeMode = remote.themeMode;
  if (typeof remote.theme === "string" && remote.theme in themes) {
    out.theme = remote.theme as ThemeName;
    out.themeMode ??= remote.theme as ThemeMode;
  }
  if (out.themeMode !== undefined) out.theme = resolveThemeMode(out.themeMode);
  if (
    remote.density === "compact" ||
    remote.density === "regular" ||
    remote.density === "comfy"
  ) {
    out.density = remote.density;
  }
  if (
    remote.cards === "flat" ||
    remote.cards === "outlined" ||
    remote.cards === "elevated"
  ) {
    out.cardVariant = remote.cards;
  }
  // An explicit lightness override, in percent. Absent (the default) leaves
  // the dark ramp on the anchor `darkTheme` declares.
  if (
    typeof remote.bgL === "number" &&
    Number.isFinite(remote.bgL) &&
    remote.bgL >= 0 &&
    remote.bgL <= 100
  ) {
    out.bgL = remote.bgL;
  }
  // The semantic accent key lives under `accentKey`; older gateways carried it
  // in `accent` (pre-fix), so accept that as a fallback.
  if (
    typeof remote.accentKey === "string" &&
    remote.accentKey in ACCENT_PALETTE
  ) {
    out.accent = remote.accentKey as AccentKey;
  } else if (
    typeof remote.accent === "string" &&
    remote.accent in ACCENT_PALETTE
  ) {
    out.accent = remote.accent as AccentKey;
  }
  return out;
}

/** Convert typed prefs back into the gateway wire shape (vanilla `toRemoteShape`).
 *  The accent key + its resolved hex swatches are both emitted: the key so a
 *  second device can restore the exact pick, the hexes for the runtime's
 *  CSS-var injection (the gateway has no knowledge of ACCENT_PALETTE). */
export function toRemoteShape(
  patch: Partial<AppearancePrefs>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (patch.themeMode !== undefined) out.themeMode = patch.themeMode;
  if (patch.theme !== undefined) out.theme = patch.theme;
  if (patch.density !== undefined) out.density = patch.density;
  if (patch.cardVariant !== undefined) out.cards = patch.cardVariant;
  if (patch.bgL !== undefined) out.bgL = patch.bgL;
  if (patch.accent !== undefined) {
    out.accentKey = patch.accent;
    const swatch = ACCENT_PALETTE[patch.accent];
    if (swatch) {
      out.accent = swatch.accent;
      out.accentLight = swatch.light;
      out.accentDeep = swatch.deep;
    }
  }
  return out;
}

function setOrClear(
  html: HTMLElement,
  prop: string,
  value: string | undefined
): void {
  // Clearing matters as much as setting: an override that stops applying has
  // to leave the inline style behind, or the theme block never wins again.
  if (value === undefined) html.style.removeProperty(prop);
  else html.style.setProperty(prop, value);
}

/** Write the prefs onto `<html>` as data-attrs + CSS vars — the shell's
 *  atmospheric ramp + accent. Symmetric with what the gateway bakes on first
 *  paint (vanilla `applyPrefs`, minus the iframe broadcast which is an
 *  iframe-host concern handled in R3). */
export function applyPrefsToDocument(
  prefs: AppearancePrefs,
  doc: Document = document
): void {
  const html = doc.documentElement;
  html.dataset.theme = String(prefs.theme);
  html.dataset.density = prefs.density;
  html.dataset.cards = prefs.cardVariant;
  setOrClear(
    html,
    "--bg-l",
    prefs.bgL === undefined ? undefined : `${prefs.bgL}%`
  );
  const swatch =
    prefs.accent === undefined ? undefined : ACCENT_PALETTE[prefs.accent];
  setOrClear(html, "--accent", swatch?.accent);
  setOrClear(html, "--accent-light", swatch?.light);
  setOrClear(html, "--accent-deep", swatch?.deep);
}

/**
 * The lightness anchor in effect, as a number — the owner's override if they
 * moved it, else whatever the active theme declares (`5%` on Centraid Dark;
 * light themes have no anchor and fall back to the blueprint dark default).
 * The iframe theme bridge sends a number, so it needs this resolved.
 */
export function resolveBgL(prefs: AppearancePrefs): number {
  if (prefs.bgL !== undefined) return prefs.bgL;
  return parseAnchor(themes[prefs.theme]?.bgL);
}

/** The blueprint token layer's own dark anchor — the honest fallback when the
 *  active theme declares none (every light theme). */
const BLUEPRINT_DARK_BG_L = 10;

/** `'5%'` → `5`. Anything that is not a bare percentage falls back. */
export function parseAnchor(declared: string | undefined): number {
  const bare = (declared ?? "").replace("%", "").trim();
  const n = Number(bare);
  return bare !== "" && Number.isFinite(n) ? n : BLUEPRINT_DARK_BG_L;
}
