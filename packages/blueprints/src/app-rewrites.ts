/**
 * Per-app file rewrites the clone + rename paths share.
 *
 * Both `cloneTemplate` (in clone.ts) and `updateAppMeta` (in
 * scaffold.ts) need to push a new display name into an app's
 * subordinate files — the cloned `index.html`'s `<title>` and any
 * `automations/<id>/automation.json#name`. Keeping these helpers in
 * one place keeps the two surfaces in lockstep so a rename can't leave
 * the browser-tab title stale, and an automation app's Automations row
 * title can't drift from its wrapping `app.json#name`.
 *
 * Every helper is defensive on every branch: missing files / unparseable
 * JSON / unrelated content → no-op. The same call serves a UI app
 * (rewrites `<title>`, no automations/) and an automation app (no
 * `index.html`, rewrites `automations/<id>/automation.json`).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Pure string variant: replace the first `<title>...</title>` in an HTML
 * string with `newName` (HTML-escaped). No `<title>` → returns the input
 * unchanged. Shared by the filesystem path ({@link rewriteIndexHtmlTitle})
 * and the git-store file-map path (issue #141).
 */
export function rewriteTitleInHtml(html: string, newName: string): string {
  const re = /<title>[\s\S]*?<\/title>/i;
  if (!re.test(html)) return html; // no <title> tag — leave the string untouched.
  // Callback form so $-sequences in `newName` aren't interpreted as
  // backreferences by `String.replace`. Regex has no /g so only the
  // first <title> is rewritten.
  return html.replace(re, () => `<title>${escapeHtml(newName)}</title>`);
}

/**
 * Replace the first `<title>...</title>` in `<appDir>/index.html`
 * with `newName`. HTML-escapes the name so a user-chosen "Foo & Bar"
 * can't break the markup or smuggle a tag in.
 *
 * Missing `index.html` → no-op. No `<title>` tag → no-op. Only the
 * first match is replaced.
 */
export async function rewriteIndexHtmlTitle(appDir: string, newName: string): Promise<void> {
  const htmlPath = path.join(appDir, 'index.html');
  let raw: string;
  try {
    raw = await fs.readFile(htmlPath, 'utf8');
  } catch {
    return; // app has no index.html (automation app) — nothing to rewrite.
  }
  const next = rewriteTitleInHtml(raw, newName);
  if (next !== raw) await fs.writeFile(htmlPath, next);
}

/**
 * Tile visual identity (icon glyph + hue) carried in `app.json`. Keys are
 * plain strings at this layer — the catalog (`index.json`) declares them
 * with the `@centraid/design-tokens` types, and the shells validate before
 * rendering, so the rewrite stays pass-through.
 */
export interface AppVisualIdentity {
  iconKey?: string;
  colorKey?: string;
}

/**
 * Pure string variant: backfill `iconKey` / `colorKey` in an `app.json`
 * string from the template's catalog entry (issue #263 — tile identity
 * lives at the source, not in a desktop localStorage shim). Keys the
 * manifest already declares win — a template's own app.json is copied
 * verbatim on clone, so this only fills gaps (older cached template
 * copies that predate the keys). Returns `null` when the input is
 * unparseable so the caller can skip it.
 */
export function applyAppVisualIdentity(raw: string, visual: AppVisualIdentity): string | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null; // unparseable — caller leaves it alone.
  }
  if (visual.iconKey && typeof parsed.iconKey !== 'string') parsed.iconKey = visual.iconKey;
  if (visual.colorKey && typeof parsed.colorKey !== 'string') parsed.colorKey = visual.colorKey;
  return JSON.stringify(parsed, null, 2) + '\n';
}

/**
 * Backfill `iconKey` / `colorKey` in `<appDir>/app.json` from the
 * template's catalog entry. Missing or unparseable app.json → no-op;
 * keys already present in the manifest are left alone.
 */
export async function stampAppVisualIdentity(
  appDir: string,
  visual: AppVisualIdentity,
): Promise<void> {
  const appJsonPath = path.join(appDir, 'app.json');
  let raw: string;
  try {
    raw = await fs.readFile(appJsonPath, 'utf8');
  } catch {
    return; // app has no app.json — nothing to stamp.
  }
  const next = applyAppVisualIdentity(raw, visual);
  if (next !== null && next !== raw) await fs.writeFile(appJsonPath, next);
}

export interface AutomationManifestRewriteOptions {
  /**
   * When true, also reset `generated` to
   * `{by:'centraid-builder', at:<now>}`. Used by the clone path so a
   * fresh clone's manifest reflects the clone time, not the original
   * template-authoring time. The rename path leaves `generated` alone.
   */
  stampGenerated?: boolean;
}

/**
 * Pure string variant: rewrite `name` (and optionally re-stamp
 * `generated`) in an `automation.json` string. Returns `null` when the
 * input is unparseable so the caller can skip it. Shared by the
 * filesystem walker and the git-store file-map path (issue #141).
 */
export function applyManifestName(
  raw: string,
  newName: string,
  opts: AutomationManifestRewriteOptions = {},
): string | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null; // unparseable — caller leaves it alone.
  }
  parsed.name = newName;
  if (opts.stampGenerated) {
    parsed.generated = { by: 'centraid-builder', at: new Date().toISOString() };
  }
  return JSON.stringify(parsed, null, 2) + '\n';
}

/**
 * Walk `<appDir>/automations/<id>/automation.json` and rewrite the
 * top-level `name` field in each manifest to `newName`. With
 * `stampGenerated: true`, also resets `generated.{by,at}` to
 * `centraid-builder` + now.
 *
 * No-op when the app has no `automations/` subdir (regular UI apps
 * with no scheduled jobs). Each per-automation file is treated
 * independently: a missing or unparseable manifest is skipped, the
 * rest still get rewritten.
 */
export async function rewriteAutomationManifestNames(
  appDir: string,
  newName: string,
  opts: AutomationManifestRewriteOptions = {},
): Promise<void> {
  const autoRoot = path.join(appDir, 'automations');
  let names: string[];
  try {
    names = await fs.readdir(autoRoot);
  } catch {
    return; // no automations/ subdir — nothing to do.
  }
  for (const name of names) {
    if (name.startsWith('.') || name.startsWith('_')) continue;
    const manifestPath = path.join(autoRoot, name, 'automation.json');
    // readFile naturally fails for non-directories and missing manifests,
    // so we don't need a separate `isDirectory()` check via Dirent.
    let raw: string;
    try {
      raw = await fs.readFile(manifestPath, 'utf8');
    } catch {
      continue;
    }
    const next = applyManifestName(raw, newName, opts);
    if (next !== null) await fs.writeFile(manifestPath, next);
  }
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
