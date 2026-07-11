/**
 * Automation apps on disk.
 *
 * Issue #98 (unified folder model): an automation is never standalone.
 * It always lives inside an app folder, at
 * `<appCodeDir>/automations/<id>/`. The app folder is the unit of
 * upload and versioning — an automation versions *with* its app. There
 * is no separate `automationsDir`.
 *
 *   <appCodeDir>/automations/<id>/automation.json  — the manifest
 *   <appCodeDir>/automations/<id>/handler.js       — the handler
 *
 * `appsDir` here is an app-CODE root: `<appsDir>/<id>/automations/...`.
 * Callers pass the live git-store `main` worktree's `apps/` dir (the
 * gateway's cron scheduler / run-now / webhook fire paths); the
 * draft builder passes its session worktree's `apps/` dir. Code lives in
 * the worktree (issue #137); the per-app DATA dir is resolved separately.
 *
 * An automation's globally-unique handle is `<appId>/<id>` — see
 * `formatRef`. This module lists, reads, and mutates manifests
 * of apps that already exist.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  HANDLER_FILE,
  MANIFEST_FILE,
  ManifestError,
  parseManifest,
  type Manifest,
  type Trigger,
} from '../manifest/manifest.js';
import { formatRef, isValidId } from '../manifest/ref.js';

/** Subdirectory under an app's code dir that holds the app's automations. */
export const APP_AUTOMATIONS_SUBDIR = 'automations';

/**
 * A resolved automation app — the directory, its id, the owning app,
 * and the parsed manifest, plus the few fields a scheduler host reads
 * hoisted to the top level.
 */
export interface Row {
  /** Directory name — the automation's id, unique within its app. */
  readonly id: string;
  /** Absolute path to the automation app directory. */
  readonly dir: string;
  /** Display name from the manifest. */
  readonly name: string;
  /** Trigger list hoisted from `manifest.triggers`. */
  readonly triggers: readonly Trigger[];
  /** User on/off toggle from the manifest. */
  readonly enabled: boolean;
  /** Id of the app folder this automation belongs to. */
  readonly ownerApp: string;
  /** Globally-unique handle — `<ownerApp>/<id>`. */
  readonly ref: string;
  readonly manifest: Manifest;
}

/** One app that failed to parse during a directory scan. */
export interface AppError {
  /** `<appId>/<automationId>` of the app that failed to parse. */
  readonly id: string;
  readonly error: string;
  readonly code?: string;
}

export interface ListAppsResult {
  readonly rows: Row[];
  readonly errors: AppError[];
}

function rowFrom(id: string, dir: string, manifest: Manifest, ownerApp: string): Row {
  return {
    id,
    dir,
    name: manifest.name,
    triggers: manifest.triggers,
    enabled: manifest.enabled,
    ownerApp,
    ref: formatRef(ownerApp, id),
    manifest,
  };
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

/** Absolute path to an automation app's manifest file. */
export function manifestPath(automationDir: string): string {
  return path.join(automationDir, MANIFEST_FILE);
}

/** Absolute path to an automation app's generated handler. */
export function handlerPath(automationDir: string): string {
  return path.join(automationDir, HANDLER_FILE);
}

/**
 * Read one automation app from an explicit app directory. The
 * id is the directory basename; `ownerApp` is the owning app's id.
 * Returns `undefined` if the directory or its `automation.json` is
 * missing; throws `ManifestError` when the manifest exists but
 * is invalid.
 */
export async function readAppAt(dir: string, ownerApp: string): Promise<Row | undefined> {
  const id = path.basename(dir);
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, MANIFEST_FILE), 'utf8');
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw err;
  }
  let manifest: Manifest;
  try {
    manifest = parseManifest(raw);
  } catch (err) {
    if (err instanceof ManifestError) {
      throw new ManifestError(err.code, `${ownerApp}/${id}: ${err.message}`);
    }
    throw err;
  }
  return rowFrom(id, dir, manifest, ownerApp);
}

/**
 * Resolve one app-owned automation by `(appId, automationId)`, reading
 * from the app's *active version* code dir. Returns `undefined` when the
 * app, the automation directory, or its `automation.json` is missing;
 * throws `ManifestError` when the manifest is invalid.
 */
export async function readAppOwned(
  appsDir: string,
  appId: string,
  automationId: string,
): Promise<Row | undefined> {
  if (!isValidId(automationId)) return undefined;
  const codeDir = path.join(appsDir, appId);
  return readAppAt(path.join(codeDir, APP_AUTOMATIONS_SUBDIR, automationId), appId);
}

/**
 * The full automation registry: scan every app folder under `appsDir`,
 * resolve its active-version code dir, and read every automation under
 * `<codeDir>/automations/`. A missing `appsDir`, or an app with no
 * `automations/` subdir, contributes nothing. Apps with an invalid
 * manifest land in `errors` and don't block the rest.
 */
export async function list(appsDir: string): Promise<ListAppsResult> {
  let appEntries: import('node:fs').Dirent[];
  try {
    appEntries = await fs.readdir(appsDir, { withFileTypes: true });
  } catch (err) {
    if (isEnoent(err)) return { rows: [], errors: [] };
    throw err;
  }
  const rows: Row[] = [];
  const errors: AppError[] = [];
  for (const app of appEntries) {
    if (!app.isDirectory()) continue;
    if (app.name.startsWith('.') || app.name.startsWith('_')) continue;
    const codeDir = path.join(appsDir, app.name);
    const autoRoot = path.join(codeDir, APP_AUTOMATIONS_SUBDIR);
    let autoEntries: import('node:fs').Dirent[];
    try {
      autoEntries = await fs.readdir(autoRoot, { withFileTypes: true });
    } catch (err) {
      if (isEnoent(err)) continue;
      throw err;
    }
    for (const e of autoEntries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
      try {
        const row = await readAppAt(path.join(autoRoot, e.name), app.name);
        if (row) rows.push(row);
      } catch (err) {
        errors.push({
          id: `${app.name}/${e.name}`,
          error: err instanceof Error ? err.message : String(err),
          ...(err instanceof ManifestError ? { code: err.code } : {}),
        });
      }
    }
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return { rows, errors };
}

/** Overwrite the `automation.json` in an explicit app directory. */
export async function writeManifestAt(dir: string, manifest: Manifest): Promise<void> {
  await fs.writeFile(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n');
}
