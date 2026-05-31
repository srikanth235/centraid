import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AppInfo } from './scaffold-types.js';
import { AppScaffoldError } from './scaffold-types.js';
import {
  applyManifestName,
  rewriteAutomationManifestNames,
  rewriteIndexHtmlTitle,
  rewriteTitleInHtml,
} from './app-rewrites.js';
import type { ScaffoldFile } from './scaffold-files.js';
import { isDisplayNameTaken, validateAppId } from './scaffold.js';

/**
 * Options for {@link cloneTemplate}.
 */
export interface CloneTemplateOptions {
  /** Absolute path under which the new app folder is created. */
  appsDir: string;
  /** Id for the new app (folder name). Validated against the standard rules. */
  newAppId: string;
  /** Absolute path to the template's source directory (e.g. from `@centraid/app-templates`). */
  templateDir: string;
  /** Optional display name; defaults to whatever the template's `app.json` had. */
  newName?: string;
  /**
   * Optional one-line description, seeded from the template manifest by the
   * caller so the cloned app's `app.json` carries it forward (the
   * builder surfaces it under the title and the home tile uses it as the
   * tile subtitle).
   */
  newDesc?: string;
}

/**
 * Copy a bundled template into `<appsDir>/<newAppId>/` and rewrite the
 * pieces that need to be unique to the new instance:
 *
 *   - `app.json#name`    → `newName` (or the template's existing name)
 *   - `app.json#version` → `"0.1.0"` (the clone is a fresh app, not the template)
 *   - `package.json#name` → `centraid-app-<newAppId>` (only if it followed the
 *      `centraid-app-*` convention; foreign names are left alone)
 *
 * Throws `AppScaffoldError`:
 *   - `invalid_id`     — `newAppId` fails the id regex
 *   - `already_exists` — destination dir already exists
 *   - `no_app`     — `templateDir` is missing or not a directory
 */
export async function cloneTemplate(opts: CloneTemplateOptions): Promise<AppInfo> {
  validateAppId(opts.newAppId);

  const destDir = path.join(opts.appsDir, opts.newAppId);
  if (await pathExists(destDir)) {
    throw new AppScaffoldError(
      'already_exists',
      `App "${opts.newAppId}" already exists at ${destDir}.`,
    );
  }

  if (!(await dirExists(opts.templateDir))) {
    throw new AppScaffoldError('no_app', `Template source not found: ${opts.templateDir}`);
  }

  await fs.mkdir(opts.appsDir, { recursive: true });
  await copyDir(opts.templateDir, destDir);

  // Ensure the canonical centraid subdirs exist. `scaffoldApp`
  // produces all four; this call backstops templates that pre-date
  // one. Bundled templates may ship automations as
  // `automations/<id>/` folders (e.g.
  // `journal/automations/weekly-recap/`); those carry through
  // unchanged via `copyDir` above — this step only adds missing
  // directories, never overwrites contents (issue #70).
  await ensureCanonicalSubdirs(destDir);

  await rewriteAppJson(destDir, opts.newName, opts.newDesc, opts.newAppId);
  await rewritePackageJson(destDir, opts.newAppId);
  // Keep the browser-tab title aligned with the new display name. The
  // template's <title> is hardcoded to its own brand ("Hydrate"), which
  // would otherwise leak into every clone's tab title even after the
  // user renames the app.
  if (opts.newName) await rewriteIndexHtmlTitle(destDir, opts.newName);
  // Automation templates carry a sibling `automation.json#name` whose
  // value the Automations page surfaces as the row title. Keep it in
  // sync with `app.json#name` so a clone of "Briefing" → "Briefing 2"
  // is consistent across both surfaces. The clone path stamps
  // `generated.{by,at}` too so the manifest reflects the clone time
  // rather than the original template's authoring time. No-op for app
  // templates with no automations/<id>/ subdirs.
  if (opts.newName) {
    await rewriteAutomationManifestNames(destDir, opts.newName, { stampGenerated: true });
  }

  const stat = await fs.stat(destDir);
  const hasIndex = await fileExists(path.join(destDir, 'index.html'));
  const built = await hasAnyBuiltJs(destDir);
  const meta = await readAppMeta(destDir);

  return {
    id: opts.newAppId,
    dir: destDir,
    built,
    modifiedAt: stat.mtime.toISOString(),
    name: meta.name,
    description: meta.description,
    ...(meta.kind ? { kind: meta.kind } : {}),
    hasIndex,
  };
}

/**
 * Suggest a non-colliding app id starting from `preferred`. If `preferred`
 * is free, returns it; otherwise tries `preferred-2`, `preferred-3`, ...
 * until one is free (capped at 1000 attempts as a safety bound).
 *
 * Pass `{ alwaysSuffix: true }` to skip the bare `preferred` candidate and
 * start at `preferred-2`. Used by the template-clone path so a clone never
 * consumes the template's own id — keeps templates and clones cleanly
 * separated even on the first clone.
 */
export async function suggestAppId(
  appsDir: string,
  preferred: string,
  opts: { alwaysSuffix?: boolean } = {},
): Promise<string> {
  validateAppId(preferred);
  const start = opts.alwaysSuffix ? 2 : 1;
  for (let i = start; i <= 1000; i++) {
    const candidate = i === 1 ? preferred : `${preferred}-${i}`;
    if (!(await pathExists(path.join(appsDir, candidate)))) {
      return candidate;
    }
  }
  // Astronomically unlikely; surface as a clear error rather than loop forever.
  throw new AppScaffoldError(
    'already_exists',
    `Could not find a free id starting from "${preferred}".`,
  );
}

/**
 * Pick a `(id, name)` pair where the directory id is free AND the display
 * name doesn't collide with any existing app's `app.json#name`. Used by
 * the default template-clone path so two clones never both surface as
 * "Hydrate" on the home shelf — directory ids are unique by construction
 * (`suggestAppId`), but display names have to be probed against siblings
 * (the user may have renamed an unrelated app to "Hydrate 2" earlier).
 *
 * Probes the bare `(preferredId, preferredName)` first — the very first
 * clone of `hydrate` should be just "Hydrate" / `hydrate`, not awkward
 * "Hydrate 2" / `hydrate-2`. Falls through to `(preferredId-N,
 * `${preferredName} N`)` with `N = 2, 3, …` only on collision. Caps at
 * 1000 attempts; throws `already_exists` if every candidate is taken.
 *
 * The template and the user's clone live in different filesystem trees
 * (`packages/app-templates/<id>/` vs `<appsDir>/<id>/`), so a clone
 * using the template's bare id is not a collision — the gateway only
 * routes `<appsDir>` entries.
 */
export async function suggestCloneIdentity(
  appsDir: string,
  preferredId: string,
  preferredName: string,
): Promise<{ id: string; name: string }> {
  validateAppId(preferredId);
  for (let n = 1; n <= 1000; n++) {
    const id = n === 1 ? preferredId : `${preferredId}-${n}`;
    if (await pathExists(path.join(appsDir, id))) continue;
    const name = n === 1 ? preferredName : `${preferredName} ${n}`;
    if (await isDisplayNameTaken(appsDir, name)) continue;
    return { id, name };
  }
  throw new AppScaffoldError(
    'already_exists',
    `Could not find a free id+name starting from "${preferredId}" / "${preferredName}".`,
  );
}

/**
 * Filesystem-free variant of {@link suggestCloneIdentity} for the
 * git-store backend (issue #137): the desktop no longer has a local
 * workspace dir to scan, so the caller hands in the already-published
 * apps (id + optional display name, e.g. from `listAppsWithMeta()`).
 * Same bare-first-then-`-N` advancement and 1000-attempt cap. Id and
 * display-name collisions are checked case-insensitively against the
 * supplied set; both advance in lockstep so the home shelf never shows
 * two identically-titled tiles for fresh clones.
 */
export function suggestCloneIdentityFrom(
  existing: ReadonlyArray<{ id: string; name?: string }>,
  preferredId: string,
  preferredName: string,
): { id: string; name: string } {
  validateAppId(preferredId);
  const takenIds = new Set(existing.map((a) => a.id));
  const takenNames = new Set(
    existing.map((a) => (a.name ?? a.id).trim().toLowerCase()).filter((n) => n.length > 0),
  );
  for (let n = 1; n <= 1000; n++) {
    const id = n === 1 ? preferredId : `${preferredId}-${n}`;
    if (takenIds.has(id)) continue;
    const name = n === 1 ? preferredName : `${preferredName} ${n}`;
    if (takenNames.has(name.trim().toLowerCase())) continue;
    return { id, name };
  }
  throw new AppScaffoldError(
    'already_exists',
    `Could not find a free id+name starting from "${preferredId}" / "${preferredName}".`,
  );
}

export interface CloneTemplateFilesOptions {
  /** Id for the new app. Validated against the standard rules. */
  newAppId: string;
  /** The template's files (the desktop reads its bundled catalog locally). */
  templateFiles: ScaffoldFile[];
  /** Optional display name; defaults to the template's `app.json#name`. */
  newName?: string;
  /** Optional one-line description; defaults to the template's. */
  newDesc?: string;
}

/**
 * Filesystem-free variant of {@link cloneTemplate} for the git-store/HTTP
 * path (issue #141). Takes the template's file map and returns the full
 * rewritten file map for the new app — same rewrites as the disk path:
 *   - `app.json` → fresh `id`, `name`, `version` "0.1.0", carried/overridden `description`
 *   - `package.json#name` → `centraid-app-<id>` (only if it followed the convention)
 *   - `index.html` `<title>` → new name
 *   - `automations/<id>/automation.json#name` + re-stamped `generated`
 * Seeds `automations/README.md` when the template ships no automations.
 */
export function cloneTemplateFiles(opts: CloneTemplateFilesOptions): ScaffoldFile[] {
  validateAppId(opts.newAppId);
  const out = opts.templateFiles.map((f) => ({ ...f }));
  const byPath = new Map(out.map((f, i) => [f.path, i] as const));

  const set = (p: string, content: string): void => {
    const idx = byPath.get(p);
    if (idx === undefined) {
      byPath.set(p, out.length);
      out.push({ path: p, content });
    } else {
      out[idx] = { path: p, content };
    }
  };

  // app.json — fresh id/version, name + description applied.
  const appJsonIdx = byPath.get('app.json');
  let parsedAppJson: Record<string, unknown> = {};
  if (appJsonIdx !== undefined) {
    try {
      parsedAppJson = JSON.parse(out[appJsonIdx]!.content) as Record<string, unknown>;
    } catch {
      parsedAppJson = {};
    }
  }
  const nextName =
    opts.newName ?? (typeof parsedAppJson.name === 'string' ? parsedAppJson.name : 'Untitled');
  const nextAppJson: Record<string, unknown> = {
    ...parsedAppJson,
    id: opts.newAppId,
    name: nextName,
    version: '0.1.0',
  };
  const descSource =
    opts.newDesc ??
    (typeof parsedAppJson.description === 'string' ? parsedAppJson.description : '');
  const descTrimmed = descSource.trim();
  if (descTrimmed) nextAppJson.description = descTrimmed;
  else delete nextAppJson.description;
  set('app.json', JSON.stringify(nextAppJson, null, 2) + '\n');

  // package.json — only rewrite the convention-following name.
  const pkgIdx = byPath.get('package.json');
  if (pkgIdx !== undefined) {
    try {
      const pkg = JSON.parse(out[pkgIdx]!.content) as { name?: unknown } & Record<string, unknown>;
      if (typeof pkg.name === 'string' && pkg.name.startsWith('centraid-app-')) {
        pkg.name = `centraid-app-${opts.newAppId}`;
        set('package.json', JSON.stringify(pkg, null, 2) + '\n');
      }
    } catch {
      /* unparseable — leave alone */
    }
  }

  if (opts.newName) {
    const htmlIdx = byPath.get('index.html');
    if (htmlIdx !== undefined) {
      set('index.html', rewriteTitleInHtml(out[htmlIdx]!.content, opts.newName));
    }
    for (const f of out) {
      if (!/^automations\/[^/]+\/automation\.json$/.test(f.path)) continue;
      const next = applyManifestName(f.content, opts.newName, { stampGenerated: true });
      if (next !== null) set(f.path, next);
    }
  }

  // Seed an automations brief when the template ships none.
  const hasAutomation = out.some((f) => /^automations\/[^/]+\/automation\.json$/.test(f.path));
  if (!hasAutomation && !byPath.has('automations/README.md')) {
    set('automations/README.md', AUTOMATIONS_README);
  }
  return out;
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
    }
    // Symlinks/other types: skip. Templates only ship plain files.
  }
}

async function rewriteAppJson(
  destDir: string,
  newName?: string,
  newDesc?: string,
  newAppId?: string,
): Promise<void> {
  const appJsonPath = path.join(destDir, 'app.json');
  let parsed: { name?: unknown; description?: unknown; version?: unknown } & Record<
    string,
    unknown
  > = {};
  try {
    const raw = await fs.readFile(appJsonPath, 'utf8');
    parsed = JSON.parse(raw);
  } catch {
    // No app.json in the template (or unparseable). Write a fresh one.
  }
  const next: Record<string, unknown> = {
    ...parsed,
    name: newName ?? (typeof parsed.name === 'string' ? parsed.name : 'Untitled'),
    version: '0.1.0',
  };
  // The cloned app gets a fresh id — the manifest's `id` field must
  // track the new folder name, not the template's original id. Without
  // this the dispatcher's manifest-id check would mismatch the
  // registry id (which is the folder name).
  if (newAppId) next.id = newAppId;
  // Caller-provided `newDesc` wins; otherwise preserve whatever the template
  // had. Empty strings clear the field.
  const descSource = newDesc ?? (typeof parsed.description === 'string' ? parsed.description : '');
  const descTrimmed = descSource.trim();
  if (descTrimmed) next.description = descTrimmed;
  else delete next.description;
  await fs.writeFile(appJsonPath, JSON.stringify(next, null, 2) + '\n');
}

async function rewritePackageJson(destDir: string, newAppId: string): Promise<void> {
  const pkgPath = path.join(destDir, 'package.json');
  let raw: string;
  try {
    raw = await fs.readFile(pkgPath, 'utf8');
  } catch {
    return; // template doesn't ship a package.json; nothing to rewrite.
  }
  let parsed: { name?: unknown } & Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return; // unparseable; leave alone.
  }
  const currentName = typeof parsed.name === 'string' ? parsed.name : '';
  // Only rewrite names that follow the `centraid-app-*` convention; leave
  // unrelated names alone so we don't clobber author intent.
  if (!currentName.startsWith('centraid-app-')) return;
  parsed.name = `centraid-app-${newAppId}`;
  await fs.writeFile(pkgPath, JSON.stringify(parsed, null, 2) + '\n');
}

async function readAppMeta(
  appDir: string,
): Promise<{ name?: string; description?: string; kind?: 'app' | 'automation' }> {
  try {
    const raw = await fs.readFile(path.join(appDir, 'app.json'), 'utf8');
    const parsed = JSON.parse(raw) as { name?: unknown; description?: unknown; kind?: unknown };
    const name =
      typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : undefined;
    const description =
      typeof parsed.description === 'string' && parsed.description.length > 0
        ? parsed.description
        : undefined;
    const kind = parsed.kind === 'automation' || parsed.kind === 'app' ? parsed.kind : undefined;
    return { name, description, kind };
  } catch {
    return {};
  }
}

/**
 * Canonical centraid subdirs every app carries. Kept in sync with
 * `scaffoldApp` so cloned apps look identical to fresh ones.
 * Idempotent — `mkdir { recursive: true }` is a no-op on existing dirs,
 * so re-cloning or cloning an already-canonical template is fine.
 */
const CANONICAL_SUBDIRS = ['queries', 'actions', 'migrations', 'automations'] as const;

async function ensureCanonicalSubdirs(appDir: string): Promise<void> {
  await Promise.all(
    CANONICAL_SUBDIRS.map((sub) => fs.mkdir(path.join(appDir, sub), { recursive: true })),
  );
  // Seed a brief only when the template didn't ship one of its own.
  // The brief is a placeholder for an empty `automations/` folder —
  // its presence means "no manifests here yet," not "this is all the
  // template provides." Templates that bundle real manifests usually
  // ship their own README alongside them; either way, we never
  // clobber existing content.
  const readmePath = path.join(appDir, 'automations', 'README.md');
  try {
    await fs.access(readmePath);
  } catch {
    await fs.writeFile(readmePath, AUTOMATIONS_README);
  }
}

const AUTOMATIONS_README = `# automations/

This folder holds the scheduled jobs the app owns. Each automation is
its own folder — \`automations/<id>/automation.json\` (the manifest) +
\`automations/<id>/handler.js\` (the handler the scheduler fires).
Existing automations appear in the desktop's App settings →
Automations panel; this README is only seeded when the folder is
empty, so seeing it means no automations ship with this app yet.

To add one, ask the builder agent ("set up an automation that
runs every Monday at 9am…") — it scaffolds both files and the
desktop picks them up on the next sync. See the app root
\`README.md\` for the full manifest shape.
`;

async function hasAnyBuiltJs(appDir: string): Promise<boolean> {
  for (const sub of ['queries', 'actions']) {
    const dir = path.join(appDir, sub);
    const entries = await fs.readdir(dir).catch(() => []);
    if (entries.some((n) => n.endsWith('.js') || n.endsWith('.mjs'))) return true;
  }
  return false;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}
