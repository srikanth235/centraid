// Appearance prefs — the renderer-owned theme/density/accent settings, ported
// out of the vanilla app.ts. Pure helpers here (validation + wire mapping +
// the document side-effect); the React hook that owns the live value and the
// gateway round-trip lives in useAppearance.ts.
import { themes } from '@centraid/design-tokens';
import {
  ACCENT_PALETTE,
  type AccentKey,
  type AppearancePrefs,
  type ThemeName,
} from '../../app-shell-context.js';

export const DEFAULT_PREFS: AppearancePrefs = {
  accent: 'teal',
  bgL: 5,
  cardVariant: 'outlined',
  coolBlueCast: true,
  density: 'regular',
  sidebarOpen: true,
  theme: 'dark',
  tileVariant: 'gradient',
};

/** Fold an arbitrary remote prefs object onto the typed AppearancePrefs shape,
 *  dropping unknown keys and values that don't match the unions. Mirrors the
 *  gateway's KNOWN_KEYS list (vanilla `pickAppearance`). */
export function pickAppearance(remote: Record<string, unknown>): Partial<AppearancePrefs> {
  const out: Partial<AppearancePrefs> = {};
  if (typeof remote.theme === 'string' && remote.theme in themes) {
    out.theme = remote.theme as ThemeName;
  }
  if (remote.density === 'compact' || remote.density === 'regular' || remote.density === 'comfy') {
    out.density = remote.density;
  }
  if (remote.cards === 'flat' || remote.cards === 'outlined' || remote.cards === 'elevated') {
    out.cardVariant = remote.cards;
  }
  if (typeof remote.coolCast === 'boolean') out.coolBlueCast = remote.coolCast;
  // The semantic accent key lives under `accentKey`; older gateways carried it
  // in `accent` (pre-fix), so accept that as a fallback.
  if (typeof remote.accentKey === 'string' && remote.accentKey in ACCENT_PALETTE) {
    out.accent = remote.accentKey as AccentKey;
  } else if (typeof remote.accent === 'string' && remote.accent in ACCENT_PALETTE) {
    out.accent = remote.accent as AccentKey;
  }
  return out;
}

/** Convert typed prefs back into the gateway wire shape (vanilla `toRemoteShape`).
 *  The accent key + its resolved hex swatches are both emitted: the key so a
 *  second device can restore the exact pick, the hexes for the runtime's
 *  CSS-var injection (the gateway has no knowledge of ACCENT_PALETTE). */
export function toRemoteShape(patch: Partial<AppearancePrefs>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (patch.theme !== undefined) out.theme = patch.theme;
  if (patch.density !== undefined) out.density = patch.density;
  if (patch.cardVariant !== undefined) out.cards = patch.cardVariant;
  if (patch.coolBlueCast !== undefined) out.coolCast = patch.coolBlueCast;
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

/** Write the prefs onto `<html>` as data-attrs + CSS vars — the shell's
 *  atmospheric ramp + accent. Symmetric with what the gateway bakes on first
 *  paint (vanilla `applyPrefs`, minus the iframe broadcast which is an
 *  iframe-host concern handled in R3). */
export function applyPrefsToDocument(prefs: AppearancePrefs, doc: Document = document): void {
  const html = doc.documentElement;
  html.dataset.theme = String(prefs.theme);
  html.dataset.density = prefs.density;
  html.dataset.cards = prefs.cardVariant;
  html.dataset.coolCast = prefs.coolBlueCast ? 'on' : 'off';
  html.style.setProperty('--bg-l', `${prefs.bgL}%`);
  const swatch = ACCENT_PALETTE[prefs.accent];
  html.style.setProperty('--accent', swatch.accent);
  html.style.setProperty('--accent-light', swatch.light);
  html.style.setProperty('--accent-deep', swatch.deep);
}
