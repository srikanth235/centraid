/**
 * Per-project file rewrites the clone + rename paths share.
 *
 * Both `cloneTemplate` (in clone.ts) and `updateProjectMeta` (in
 * scaffold.ts) need to push a new display name into a project's
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
 * Replace the first `<title>...</title>` in `<projectDir>/index.html`
 * with `newName`. HTML-escapes the name so a user-chosen "Foo & Bar"
 * can't break the markup or smuggle a tag in.
 *
 * Missing `index.html` → no-op. No `<title>` tag → no-op. Only the
 * first match is replaced.
 */
export async function rewriteIndexHtmlTitle(projectDir: string, newName: string): Promise<void> {
  const htmlPath = path.join(projectDir, 'index.html');
  let raw: string;
  try {
    raw = await fs.readFile(htmlPath, 'utf8');
  } catch {
    return; // project has no index.html (automation app) — nothing to rewrite.
  }
  const escaped = escapeHtml(newName);
  let replaced = false;
  const next = raw.replace(/<title>[\s\S]*?<\/title>/i, () => {
    if (replaced) return `<title>${escaped}</title>`;
    replaced = true;
    return `<title>${escaped}</title>`;
  });
  if (!replaced) return; // no <title> tag — leave the file untouched.
  await fs.writeFile(htmlPath, next);
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
 * Walk `<projectDir>/automations/<id>/automation.json` and rewrite the
 * top-level `name` field in each manifest to `newName`. With
 * `stampGenerated: true`, also resets `generated.{by,at}` to
 * `centraid-builder` + now.
 *
 * No-op when the project has no `automations/` subdir (regular UI apps
 * with no scheduled jobs). Each per-automation file is treated
 * independently: a missing or unparseable manifest is skipped, the
 * rest still get rewritten.
 */
export async function rewriteAutomationManifestNames(
  projectDir: string,
  newName: string,
  opts: AutomationManifestRewriteOptions = {},
): Promise<void> {
  const autoRoot = path.join(projectDir, 'automations');
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(autoRoot, { withFileTypes: true });
  } catch {
    return; // no automations/ subdir — nothing to do.
  }
  const nowIso = opts.stampGenerated ? new Date().toISOString() : null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
    const manifestPath = path.join(autoRoot, e.name, 'automation.json');
    let raw: string;
    try {
      raw = await fs.readFile(manifestPath, 'utf8');
    } catch {
      continue; // not every subdir has a manifest (legacy / partial).
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue; // unparseable — leave alone.
    }
    parsed.name = newName;
    if (nowIso !== null) parsed.generated = { by: 'centraid-builder', at: nowIso };
    await fs.writeFile(manifestPath, JSON.stringify(parsed, null, 2) + '\n');
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
