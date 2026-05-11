/**
 * Public types for @centraid/templates.
 */

import type { ColorKey, IconName } from '@centraid/design-tokens';

/**
 * Metadata for a single template entry. Mirrors @centraid/design-tokens'
 * `AppMeta` plus a `version` field (so the gallery can detect updates) and
 * a `files` list (so the remote fetcher knows what to download).
 */
export interface TemplateMeta {
  /** Unique template id; also the folder name under `templates/`. */
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
}

/**
 * Shape of `templates/manifest.json` — the bundled (and remotely-served)
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
