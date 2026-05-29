import { promises as fs } from 'node:fs';
import path from 'node:path';
import { rewriteAutomationManifestNames, rewriteIndexHtmlTitle } from './project-rewrites.js';
import { scaffoldProjectFiles, validateAppId } from './scaffold-files.js';
import type { ProjectInfo } from './types.js';
import { HarnessError } from './types.js';

// `validateAppId` + the content templates now live in `scaffold-files.ts`
// (the filesystem-free scaffolder used by the git-store/HTTP path, issue
// #141). Re-exported here so existing importers (`clone.ts`, the CLI) are
// unaffected.
export { validateAppId } from './scaffold-files.js';

/**
 * Scaffold a new project folder under `<projectsDir>/<id>/` with the
 * minimal centraid layout. Thin filesystem wrapper over
 * {@link scaffoldProjectFiles}: writes the file map to disk and adds the
 * empty canonical subdirs the map omits (git tracks files, not dirs).
 */
export async function scaffoldProject(
  projectsDir: string,
  id: string,
  opts: { name?: string; description?: string; version?: string } = {},
): Promise<ProjectInfo> {
  validateAppId(id);
  const dir = path.join(projectsDir, id);
  if (await exists(dir)) {
    throw new HarnessError('already_exists', `Project "${id}" already exists at ${dir}.`);
  }
  await fs.mkdir(dir, { recursive: true });

  for (const file of scaffoldProjectFiles(id, opts)) {
    const dest = path.join(dir, file.path);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, file.content);
  }
  // Empty canonical subdirs the file map can't carry (queries/actions/
  // migrations start empty; the builder agent fills them in). `automations/`
  // already exists from its seeded README.
  for (const sub of ['queries', 'actions', 'migrations']) {
    await fs.mkdir(path.join(dir, sub), { recursive: true });
  }

  const stat = await fs.stat(dir);
  return {
    id,
    dir,
    built: false,
    modifiedAt: stat.mtime.toISOString(),
  };
}

/** List existing projects under projectsDir. */
export async function listProjects(projectsDir: string): Promise<ProjectInfo[]> {
  const entries = await fs.readdir(projectsDir, { withFileTypes: true }).catch(() => []);
  const out: ProjectInfo[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
    const dir = path.join(projectsDir, e.name);
    const stat = await fs.stat(dir);
    const [built, meta, hasIndex] = await Promise.all([
      hasAnyBuiltJs(dir),
      readAppMeta(dir),
      fileExists(path.join(dir, 'index.html')),
    ]);
    out.push({
      id: e.name,
      dir,
      built,
      modifiedAt: stat.mtime.toISOString(),
      name: meta.name,
      description: meta.description,
      hasIndex,
    });
  }
  out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return out;
}

/**
 * Patch a project's `app.json` with new `name` and/or `description`.
 * Preserves all other fields and creates the file if it doesn't exist
 * (older scaffolds may pre-date the requirement). The directory layout
 * isn't touched — `id` stays the directory name.
 *
 * - Empty/whitespace `name` is rejected (name is mandatory).
 * - Empty/whitespace `description` clears the field.
 */
export async function updateProjectMeta(
  projectsDir: string,
  id: string,
  patch: { name?: string; description?: string },
): Promise<void> {
  validateAppId(id);
  const dir = path.join(projectsDir, id);
  const appJsonPath = path.join(dir, 'app.json');
  let parsed: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(appJsonPath, 'utf8');
    const decoded = JSON.parse(raw) as unknown;
    if (decoded && typeof decoded === 'object') parsed = decoded as Record<string, unknown>;
  } catch {
    /* fall through: write a fresh app.json */
  }
  // Hoisted once so the rename-time validation, the app.json#name write,
  // and the post-write propagation pass to subordinate files (index.html
  // <title>, automations/<id>/automation.json#name) all use the same
  // trimmed string. `undefined` when the caller didn't ask to rename.
  const renameTo = patch.name === undefined ? undefined : patch.name.trim();
  if (patch.name !== undefined) {
    if (!renameTo) {
      throw new HarnessError('invalid_id', 'Project name cannot be empty.');
    }
    // Reject duplicates against any sibling project's display name
    // (case-insensitive, trimmed). Directory ids stay immutable; only the
    // user-visible `app.json#name` is constrained so two apps don't both
    // surface as "Hydrate" on the home shelf, sidebar, or palette.
    await assertDisplayNameUnique(projectsDir, id, renameTo);
    parsed.name = renameTo;
  }
  if (patch.description !== undefined) {
    const trimmed = patch.description.trim();
    if (trimmed) parsed.description = trimmed;
    else delete parsed.description;
  }
  await fs.writeFile(appJsonPath, JSON.stringify(parsed, null, 2) + '\n');

  // Propagate the rename to the project's subordinate files so the
  // browser-tab title and Automations row title don't drift from
  // `app.json#name`. Both helpers are no-ops when their target file
  // doesn't apply (a UI app has no `automations/`; an automation app
  // has no `index.html`), so the same call serves both kinds. The
  // rename path leaves `generated.{by,at}` on automation manifests
  // alone — only the clone path stamps it (manifest was just produced).
  if (renameTo !== undefined) {
    await rewriteIndexHtmlTitle(dir, renameTo);
    await rewriteAutomationManifestNames(dir, renameTo);
  }
}

/**
 * True when any sibling project under `projectsDir` (other than `selfId`,
 * when given) already uses `name` as its `app.json#name`. Comparison is
 * case-insensitive and whitespace-trimmed.
 */
export async function isDisplayNameTaken(
  projectsDir: string,
  name: string,
  opts: { excludeId?: string } = {},
): Promise<boolean> {
  const target = name.trim().toLowerCase();
  if (!target) return false;
  const entries = await fs.readdir(projectsDir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (opts.excludeId !== undefined && e.name === opts.excludeId) continue;
    if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
    const meta = await readAppMeta(path.join(projectsDir, e.name));
    if (meta.name && meta.name.trim().toLowerCase() === target) return true;
  }
  return false;
}

/**
 * Throw `HarnessError('already_exists')` when any sibling project under
 * `projectsDir` (other than `selfId`) already uses `name` as its display
 * name. Comparison is case-insensitive and whitespace-trimmed.
 */
async function assertDisplayNameUnique(
  projectsDir: string,
  selfId: string,
  name: string,
): Promise<void> {
  if (await isDisplayNameTaken(projectsDir, name, { excludeId: selfId })) {
    throw new HarnessError('already_exists', `An app named "${name}" already exists.`);
  }
}

/** Best-effort read of `app.json#{name,description}`. Both may be undefined. */
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

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

/**
 * Recursively delete a project directory. Refuses to act outside `projectsDir`
 * so a malformed `id` can't escalate into deleting unrelated paths.
 */
export async function deleteProject(projectsDir: string, id: string): Promise<void> {
  validateAppId(id);
  const projectsRoot = path.resolve(projectsDir);
  const target = path.resolve(projectsRoot, id);
  if (!target.startsWith(projectsRoot + path.sep) && target !== projectsRoot) {
    throw new HarnessError('no_project', `Refusing to delete path outside projects dir: ${target}`);
  }
  if (target === projectsRoot) {
    throw new HarnessError('no_project', `Refusing to delete the projects root.`);
  }
  await fs.rm(target, { recursive: true, force: true });
}

async function hasAnyBuiltJs(projectDir: string): Promise<boolean> {
  // Note: the automation handler is generated under `actions/`, so it's
  // already covered by the actions scan below. The `automations/` folder
  // itself only holds manifests, not executable code — no need to scan it.
  for (const sub of ['queries', 'actions']) {
    const dir = path.join(projectDir, sub);
    const entries = await fs.readdir(dir).catch(() => []);
    if (entries.some((n) => n.endsWith('.js') || n.endsWith('.mjs'))) return true;
  }
  return false;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
