import { themes } from "@centraid/design";

import type {
  AppearancePrefs,
  ThemeMode,
  ThemeName,
} from "../../app-shell-context.js";

export const DEFAULT_PREFS: AppearancePrefs = {
  cardVariant: "outlined",
  theme: resolveThemeMode("system"),
  themeMode: "system",
  tileVariant: "gradient",
};

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

export function pickAppearance(
  remote: Record<string, unknown>
): Partial<AppearancePrefs> {
  const out: Partial<AppearancePrefs> = {};
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

export function toRemoteShape(
  patch: Partial<AppearancePrefs>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (patch.themeMode !== undefined) out.themeMode = patch.themeMode;
  if (patch.theme !== undefined) out.theme = patch.theme;
  if (patch.cardVariant !== undefined) out.cards = patch.cardVariant;
  return out;
}

export function applyPrefsToDocument(
  prefs: AppearancePrefs,
  doc: Document = document
): void {
  const html = doc.documentElement;
  html.dataset.theme = String(prefs.theme);
  html.dataset.cards = prefs.cardVariant;
}
