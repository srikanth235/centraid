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
 * Routing — there are two namespaces:
 *
 *   - GLOBAL keys (theme/density/accent/…) are explicitly registered in
 *     `KNOWN_KEYS`. Anything outside that registry AND outside the `app*`
 *     namespace is dropped, so a typo in a global setting can't smear a
 *     stray attribute onto `<html>`.
 *
 *   - APP-LEVEL keys (any key shaped like `app<Capital>…`) are routed
 *     DYNAMICALLY. Each template declares which app knobs it honours in
 *     its `app-knobs.json`; the builder-harness can extend that list per
 *     app, so the runtime can't predict the universe of knob keys ahead
 *     of time. Routing is by name convention:
 *       - keys ending in `Color` or `Accent` → CSS var `--app-<kebab>`
 *       - everything else                    → data attr `data-app-<kebab>`
 *     Values are coerced to a non-empty string; everything else is dropped.
 *
 * Adding a new GLOBAL pref is a single edit to `KNOWN_KEYS`. Adding a new
 * per-app knob is a manifest edit in `<template>/app-knobs.json` plus the
 * matching CSS — no runtime change required.
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
 * Convert a camelCase tail (e.g. `Font`, `FontFamily`, `CornerRadius`) into
 * the kebab-case attribute / variable suffix the runtime injects onto
 * `<html>`. Used only by the dynamic `app*` routing — the registered
 * global keys (`KNOWN_KEYS`) pre-declare their target name.
 */
function camelTailToKebab(tail: string): string {
  // First char is uppercase (we strip it before calling), so we just
  // lowercase and prefix subsequent uppercase boundaries with `-`.
  return (
    tail.charAt(0).toLowerCase() + tail.slice(1).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
  );
}

/**
 * Is `key` an app-level knob? We use the camelCase prefix convention
 * `app<Capital>...` so `appFont`, `appColor`, `appCornerRadius` all match
 * but bare `app` (probably a typo) or `apps` does not.
 */
function isAppKnobKey(key: string): key is `app${string}` {
  if (key.length <= 3 || !key.startsWith('app')) return false;
  const c = key.charCodeAt(3);
  return c >= 65 && c <= 90; // 'A'..'Z'
}

/**
 * Decide whether an app-knob value lands as a data attribute or a CSS
 * variable. Convention: keys ending in `Color` or `Accent` are colours
 * (continuous CSS values), everything else is a discrete state best
 * styled with attribute selectors.
 */
function appKnobTarget(
  key: string,
): { kind: 'data'; attr: string } | { kind: 'css'; cssVar: string } {
  const kebab = camelTailToKebab(key.slice(3));
  const name = `app-${kebab}`;
  return /(?:Color|Accent)$/.test(key)
    ? { kind: 'css', cssVar: name }
    : { kind: 'data', attr: name };
}

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
    if (spec) {
      const coerced = spec.coerce ? spec.coerce(raw) : asString(raw);
      if (coerced === undefined) continue;
      if (spec.kind === 'data') {
        dataAttrs[spec.attr] = coerced;
      } else {
        cssVars[spec.cssVar] = coerced;
      }
      continue;
    }
    // Dynamic routing for the per-app `app*` namespace — keeps templates +
    // builder-harness free to introduce new knobs without a runtime change.
    if (isAppKnobKey(k)) {
      const coerced = asString(raw);
      if (coerced === undefined) continue;
      const target = appKnobTarget(k);
      if (target.kind === 'data') dataAttrs[target.attr] = coerced;
      else cssVars[target.cssVar] = coerced;
    }
  }
  return { dataAttrs, cssVars };
}
