import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ProjectInfo } from './types.js';
import { HarnessError } from './types.js';
import { isDisplayNameTaken, validateAppId } from './scaffold.js';

/**
 * Options for {@link cloneTemplate}.
 */
export interface CloneTemplateOptions {
  /** Absolute path under which the new project folder is created. */
  projectsDir: string;
  /** Id for the new app (folder name). Validated against the standard rules. */
  newAppId: string;
  /** Absolute path to the template's source directory (e.g. from `@centraid/app-templates`). */
  templateDir: string;
  /** Optional display name; defaults to whatever the template's `app.json` had. */
  newName?: string;
  /**
   * Optional one-line description, seeded from the template manifest by the
   * caller so the cloned project's `app.json` carries it forward (the
   * builder surfaces it under the title and the home tile uses it as the
   * tile subtitle).
   */
  newDesc?: string;
}

/**
 * Copy a bundled template into `<projectsDir>/<newAppId>/` and rewrite the
 * pieces that need to be unique to the new instance:
 *
 *   - `app.json#name`    → `newName` (or the template's existing name)
 *   - `app.json#version` → `"0.1.0"` (the clone is a fresh app, not the template)
 *   - `package.json#name` → `centraid-app-<newAppId>` (only if it followed the
 *      `centraid-app-*` convention; foreign names are left alone)
 *
 * Throws `HarnessError`:
 *   - `invalid_id`     — `newAppId` fails the id regex
 *   - `already_exists` — destination dir already exists
 *   - `no_project`     — `templateDir` is missing or not a directory
 */
export async function cloneTemplate(opts: CloneTemplateOptions): Promise<ProjectInfo> {
  validateAppId(opts.newAppId);

  const destDir = path.join(opts.projectsDir, opts.newAppId);
  if (await pathExists(destDir)) {
    throw new HarnessError(
      'already_exists',
      `Project "${opts.newAppId}" already exists at ${destDir}.`,
    );
  }

  if (!(await dirExists(opts.templateDir))) {
    throw new HarnessError('no_project', `Template source not found: ${opts.templateDir}`);
  }

  await fs.mkdir(opts.projectsDir, { recursive: true });
  await copyDir(opts.templateDir, destDir);

  // Ensure the canonical centraid subdirs exist. `scaffoldProject`
  // produces all four; this call backstops templates that pre-date
  // one. Bundled templates may ship automations as
  // `automations/<id>/` folders (e.g.
  // `journal/automations/weekly-recap/`); those carry through
  // unchanged via `copyDir` above — this step only adds missing
  // directories, never overwrites contents (issue #70).
  await ensureCanonicalSubdirs(destDir);

  await rewriteAppJson(destDir, opts.newName, opts.newDesc);
  await rewritePackageJson(destDir, opts.newAppId);
  // Keep the browser-tab title aligned with the new display name. The
  // template's <title> is hardcoded to its own brand ("Hydrate"), which
  // would otherwise leak into every clone's tab title even after the
  // user renames the app.
  if (opts.newName) await rewriteIndexHtmlTitle(destDir, opts.newName);

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
  projectsDir: string,
  preferred: string,
  opts: { alwaysSuffix?: boolean } = {},
): Promise<string> {
  validateAppId(preferred);
  const start = opts.alwaysSuffix ? 2 : 1;
  for (let i = start; i <= 1000; i++) {
    const candidate = i === 1 ? preferred : `${preferred}-${i}`;
    if (!(await pathExists(path.join(projectsDir, candidate)))) {
      return candidate;
    }
  }
  // Astronomically unlikely; surface as a clear error rather than loop forever.
  throw new HarnessError(
    'already_exists',
    `Could not find a free id starting from "${preferred}".`,
  );
}

/**
 * Pick a `(id, name)` pair where the directory id is free AND the display
 * name doesn't collide with any existing project's `app.json#name`. Used by
 * the default template-clone path so two clones never both surface as
 * "Hydrate" on the home shelf — directory ids are unique by construction
 * (`suggestAppId`), but display names have to be probed against siblings
 * (the user may have renamed an unrelated app to "Hydrate 2" earlier).
 *
 * Always returns a suffixed pair (`preferredId-N`, `${preferredName} N`)
 * with `N >= 2`, keeping the template's bare id/name out of clones. Caps
 * at 1000 attempts; throws `already_exists` if every candidate is taken.
 */
export async function suggestCloneIdentity(
  projectsDir: string,
  preferredId: string,
  preferredName: string,
): Promise<{ id: string; name: string }> {
  validateAppId(preferredId);
  for (let n = 2; n <= 1000; n++) {
    const id = `${preferredId}-${n}`;
    if (await pathExists(path.join(projectsDir, id))) continue;
    const name = `${preferredName} ${n}`;
    if (await isDisplayNameTaken(projectsDir, name)) continue;
    return { id, name };
  }
  throw new HarnessError(
    'already_exists',
    `Could not find a free id+name starting from "${preferredId}" / "${preferredName}".`,
  );
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

async function rewriteAppJson(destDir: string, newName?: string, newDesc?: string): Promise<void> {
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

/**
 * Replace the first `<title>...</title>` in the cloned `index.html` with
 * the new display name. HTML-escapes the name so a user-chosen
 * "Foo & Bar" can't break the markup or smuggle a tag in.
 *
 * Defensive on every branch: missing file → skip; no `<title>` tag → skip.
 * Only the first occurrence is replaced (templates never ship more than
 * one, but the bound keeps the rewrite predictable).
 */
async function rewriteIndexHtmlTitle(destDir: string, newName: string): Promise<void> {
  const htmlPath = path.join(destDir, 'index.html');
  let raw: string;
  try {
    raw = await fs.readFile(htmlPath, 'utf8');
  } catch {
    return; // template doesn't ship an index.html; nothing to rewrite.
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

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function readAppMeta(projectDir: string): Promise<{ name?: string; description?: string }> {
  try {
    const raw = await fs.readFile(path.join(projectDir, 'app.json'), 'utf8');
    const parsed = JSON.parse(raw) as { name?: unknown; description?: unknown };
    const name =
      typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : undefined;
    const description =
      typeof parsed.description === 'string' && parsed.description.length > 0
        ? parsed.description
        : undefined;
    return { name, description };
  } catch {
    return {};
  }
}

/**
 * Canonical centraid subdirs every project carries. Kept in sync with
 * `scaffoldProject` so cloned projects look identical to fresh ones.
 * Idempotent — `mkdir { recursive: true }` is a no-op on existing dirs,
 * so re-cloning or cloning an already-canonical template is fine.
 */
const CANONICAL_SUBDIRS = ['queries', 'actions', 'migrations', 'automations'] as const;

async function ensureCanonicalSubdirs(projectDir: string): Promise<void> {
  await Promise.all(
    CANONICAL_SUBDIRS.map((sub) => fs.mkdir(path.join(projectDir, sub), { recursive: true })),
  );
  // Seed a brief only when the template didn't ship one of its own.
  // The brief is a placeholder for an empty `automations/` folder —
  // its presence means "no manifests here yet," not "this is all the
  // template provides." Templates that bundle real manifests usually
  // ship their own README alongside them; either way, we never
  // clobber existing content.
  const readmePath = path.join(projectDir, 'automations', 'README.md');
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
desktop picks them up on the next sync. See the project root
\`README.md\` for the full manifest shape.
`;

async function hasAnyBuiltJs(projectDir: string): Promise<boolean> {
  for (const sub of ['queries', 'actions']) {
    const dir = path.join(projectDir, sub);
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
