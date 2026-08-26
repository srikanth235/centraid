// Validation, wire mapping, document side-effect; the live value and the
// gateway round-trip belong to useAppearance.ts.
//
// WRITE NOTHING COLOUR-SHAPED ON `<html>` (#707): an inline style outranks the
// `[data-theme='…']` block it is applying.
import { themes } from "@centraid/design";

import type {
  AppearancePrefs,
  ThemeMode,
  ThemeName,
} from "../../app-shell-context.js";

/** `system`, not `dark`. `themeMode` is the intent; `theme` is only the
 *  resolved name, re-derived by `useAppearance`. */
export const DEFAULT_PREFS: AppearancePrefs = {
  cardVariant: "outlined",
  theme: resolveThemeMode("system"),
  themeMode: "system",
  tileVariant: "gradient",
};

/** The hook must subscribe to the query it resolves against. */
export const LIGHT_SCHEME_QUERY = "(prefers-color-scheme: light)";

export function resolveThemeMode(mode: ThemeMode): ThemeName {
  if (mode !== "system") return mode;
  const mq =
    typeof matchMedia === "function" ? matchMedia(LIGHT_SCHEME_QUERY) : null;
  return mq?.matches ? "light" : "dark";
}

function isThemeMode(v: unknown): v is ThemeMode {
  return v === "system" || (typeof v === "string" && v in themes);
}

/** Drops unknown keys and off-union values (mirrors KNOWN_KEYS), including a
 *  `theme` this build no longer registers — no migration path. */
export function pickAppearance(
  remote: Record<string, unknown>
): Partial<AppearancePrefs> {
  const out: Partial<AppearancePrefs> = {};
  // Accept either, but `system` wins: the baked resolved name may be stale.
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

/** Only owner-settable keys are sent; no migration is owed. */
export function toRemoteShape(
  patch: Partial<AppearancePrefs>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (patch.themeMode !== undefined) out.themeMode = patch.themeMode;
  if (patch.theme !== undefined) out.theme = patch.theme;
  if (patch.cardVariant !== undefined) out.cards = patch.cardVariant;
  return out;
}

/** Data attributes only, never inline custom properties — the token layer owns
 *  every colour. */
export function applyPrefsToDocument(
  prefs: AppearancePrefs,
  doc: Document = document
): void {
  const html = doc.documentElement;
  html.dataset.theme = String(prefs.theme);
  html.dataset.cards = prefs.cardVariant;
}
