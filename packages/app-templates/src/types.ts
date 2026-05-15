/**
 * Public types for @centraid/app-templates.
 */

import type { ColorKey, IconName } from '@centraid/design-tokens';

/**
 * One per-app aesthetic knob declared by a template's `app-knobs.json`.
 * Drives a control in the desktop's per-app settings popover and a row in
 * the app's `__centraid_settings` table; the runtime bakes the resulting
 * value onto `<html data-app-<key-kebab>="<value>">` so the template's
 * own CSS can react to it.
 */
export interface AppKnobOption {
  value: string;
  label: string;
}
export interface AppKnob {
  /** Camel-cased settings key in the `app*` namespace (e.g. `appFont`,
   *  `appColor`). The runtime routes dynamically by key name — keys ending
   *  in `Color`/`Accent` become `--app-<kebab>` CSS vars; everything else
   *  becomes a `data-app-<kebab>` attribute on `<html>`. */
  key: string;
  /** Display label shown in the popover row. */
  label: string;
  /** Control type. `segmented` for discrete values, `swatch` for colour. */
  type: 'segmented' | 'swatch';
  /** Value to assume when the per-app table has no row for this knob. */
  default: string;
  /** Choices the user picks from. */
  options: AppKnobOption[];
}
export interface AppKnobsManifest {
  /** Manifest format version. Bump if `AppKnob` gains required fields. */
  version: number;
  knobs: AppKnob[];
}

/**
 * Metadata for a single template entry. Mirrors @centraid/design-tokens'
 * `AppMeta` plus a `version` field (so the gallery can detect updates) and
 * a `files` list (so the remote fetcher knows what to download).
 */
export interface TemplateMeta {
  /** Unique template id; also the folder name at the package root. */
  id: string;
  /** Display name shown in the gallery. */
  name: string;
  /** One-line description shown on the gallery card. */
  desc: string;
  /** Color key from @centraid/design-tokens — drives the tile hue. */
  colorKey: ColorKey;
  /** Icon key from @centraid/design-tokens — drives the tile glyph. */
  iconKey: IconName;
  /** Template version. Semver; bumped when the template's source changes. */
  version: string;
  /**
   * Files that make up the template, relative to its directory. Populated
   * by the build script (`scripts/build-manifest.mjs`) — the remote fetcher
   * downloads each entry from `<remoteUrl>/<id>/<file>`.
   */
  files: string[];
  /**
   * Optional per-app aesthetic knobs (font, page width, corner radius…).
   * Bundled by the build script when the template ships an
   * `app-knobs.json`. Each entry maps onto a `KNOWN_KEYS` setting in the
   * runtime; the desktop popover renders only the rows declared here.
   */
  appKnobs?: AppKnob[];
}

/**
 * Shape of `manifest.json` — the bundled (and remotely-served)
 * manifest.
 */
export interface TemplateManifest {
  /** Manifest format version. Bump if `TemplateMeta` gains required fields. */
  manifestVersion: number;
  templates: TemplateMeta[];
}

/**
 * Where a template's source files currently live for a given user. The
 * resolver returns `'cache'` when a remote-fetched copy supersedes the
 * bundled one, and `'bundle'` otherwise.
 */
export type TemplateSource = 'bundle' | 'cache';

export interface ResolvedTemplate extends TemplateMeta {
  /** Whether to clone from the cache directory or the bundled directory. */
  source: TemplateSource;
}
