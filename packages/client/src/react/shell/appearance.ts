// Appearance prefs — the renderer-owned theme settings, ported out of the
// vanilla app.ts. Pure helpers here (validation + wire mapping + the document
// side-effect); the React hook that owns the live value and the gateway
// round-trip lives in useAppearance.ts.
//
// The Binding Layer (#707) deleted the two colour overrides this module used
// to write inline on `<html>`: the accent swatch (the shell now spends no hue
// at all — `--accent` IS ink) and the `--bg-l` lightness anchor (the dark ramp
// is literal surface tones, not one anchor plus `calc()`). An inline style
// outranks every `[data-theme='…']` block, so a leftover override would
// silently outrank the theme it is supposedly applying — which is exactly the
// bug #608 group P fixed. Nothing colour-shaped is written here any more;
// `applyPrefsToDocument` sets data attributes and lets the theme block win.
import { themes } from "@centraid/design";

import type {
  AppearancePrefs,
  ThemeMode,
  ThemeName,
} from "../../app-shell-context.js";

export const DEFAULT_PREFS: AppearancePrefs = {
  cardVariant: "outlined",
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
    remote.cards === "flat" ||
    remote.cards === "outlined" ||
    remote.cards === "elevated"
  ) {
    out.cardVariant = remote.cards;
  }
  return out;
}

/** Convert typed prefs back into the gateway wire shape (vanilla
 *  `toRemoteShape`). Only the keys an owner can still set survive the Binding
 *  Layer flip — a stored `accent`/`bgL` on an older gateway is simply never
 *  read back (pickAppearance drops unknown keys), so no migration is owed. */
export function toRemoteShape(
  patch: Partial<AppearancePrefs>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (patch.themeMode !== undefined) out.themeMode = patch.themeMode;
  if (patch.theme !== undefined) out.theme = patch.theme;
  if (patch.cardVariant !== undefined) out.cards = patch.cardVariant;
  return out;
}

/** Write the prefs onto `<html>` as data attributes. Symmetric with what the
 *  gateway bakes on first paint (vanilla `applyPrefs`, minus the iframe
 *  broadcast which is an iframe-host concern handled in R3).
 *
 *  Attributes only, never inline custom properties: the token layer owns every
 *  colour, and an inline style here would outrank the `[data-theme='…']` block
 *  it just selected. */
export function applyPrefsToDocument(
  prefs: AppearancePrefs,
  doc: Document = document
): void {
  const html = doc.documentElement;
  html.dataset.theme = String(prefs.theme);
  html.dataset.cards = prefs.cardVariant;
}
