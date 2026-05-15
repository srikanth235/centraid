/*
 * Settings merge — gateway-wide user prefs ⊕ per-app settings ⊕ URL query
 * overrides → the `SettingsInject` payload that `static-server` bakes into
 * the served HTML.
 *
 * Precedence (lowest → highest):
 *   1. global user prefs (UserStore)
 *   2. per-app `__centraid_settings` (apps own this row)
 *   3. URL query string (live-edit / preview path used by the builder)
 *
 * Keys are routed to either the `dataAttrs` map or the `cssVars` map by
 * the `KNOWN_KEYS` table. Anything not in the table is dropped — this is
 * deliberate so a typoed key in an app's settings table doesn't end up
 * smeared across `<html>` as a stray attribute.
 *
 * Adding a new pref is a single edit to `KNOWN_KEYS`. Existing apps and
 * templates pick up the new attribute automatically once they reference
 * it from their CSS.
 */

import type { SettingsInject } from './static-server.js';

/**
 * The settings keys this build understands, plus where each one lands in
 * the served HTML. `kind: 'data'` becomes `<html data-<key>="...">`,
 * `kind: 'css'` becomes a CSS custom property on the same tag's `style`.
 *
 * Each entry also carries an optional `coerce` so values can survive
 * round-tripping through JSON — e.g. the bgL slider stores `5`, but the
 * CSS var wants `5%`.
 */
type KeySpec =
  | { kind: 'data'; attr: string; coerce?: (v: unknown) => string | undefined }
  | { kind: 'css'; cssVar: string; coerce?: (v: unknown) => string | undefined };

const asString = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;
const asPercent = (v: unknown): string | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return `${v}%`;
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v)) return `${v}%`;
  return undefined;
};
const asBoolFlag =
  (onValue: string, offValue: string) =>
  (v: unknown): string | undefined => {
    if (typeof v === 'boolean') return v ? onValue : offValue;
    if (v === 'on' || v === 'off') return v;
    return undefined;
  };

export const KNOWN_KEYS: Record<string, KeySpec> = {
  theme: { kind: 'data', attr: 'theme', coerce: asString },
  density: { kind: 'data', attr: 'density', coerce: asString },
  cards: { kind: 'data', attr: 'cards', coerce: asString },
  coolCast: { kind: 'data', attr: 'cool-cast', coerce: asBoolFlag('on', 'off') },
  // bgL is stored as a number (slider value 0-35); the CSS var wants `<n>%`.
  bgL: { kind: 'css', cssVar: 'bg-l', coerce: asPercent },
  accent: { kind: 'css', cssVar: 'accent', coerce: asString },
  accentLight: { kind: 'css', cssVar: 'accent-light', coerce: asString },
  accentDeep: { kind: 'css', cssVar: 'accent-deep', coerce: asString },
};

/**
 * Merge layered settings into the `SettingsInject` shape consumed by
 * `static-server`. Layers are merged in order — later layers override
 * earlier ones. `undefined` / `null` in any layer is treated as "no
 * value" and falls through to the previous layer.
 */
export function buildSettingsInject(
  layers: Array<Record<string, unknown> | undefined>,
): SettingsInject {
  const merged: Record<string, unknown> = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      if (v === undefined || v === null) continue;
      merged[k] = v;
    }
  }

  const dataAttrs: Record<string, string> = {};
  const cssVars: Record<string, string> = {};
  for (const [k, raw] of Object.entries(merged)) {
    const spec = KNOWN_KEYS[k];
    if (!spec) continue;
    const coerced = spec.coerce ? spec.coerce(raw) : asString(raw);
    if (coerced === undefined) continue;
    if (spec.kind === 'data') {
      dataAttrs[spec.attr] = coerced;
    } else {
      cssVars[spec.cssVar] = coerced;
    }
  }
  return { dataAttrs, cssVars };
}
