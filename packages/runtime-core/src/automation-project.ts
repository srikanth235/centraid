/**
 * Automation projects on disk.
 *
 * Issue #91: an automation is a first-class project — its own directory
 * under `automationsDir`, structurally a sibling of an app project.
 * The directory is the source of truth; there is no SQLite definition
 * table. This module is the read/write boundary over that directory:
 *
 *   <automationsDir>/<id>/automation.json   — the manifest
 *   <automationsDir>/<id>/handler.js        — the generated handler
 *   <automationsDir>/<id>/versions/         — published snapshots
 *
 * Scaffolding a fresh project (writing the initial files) lives in
 * `@centraid/builder-harness`; this module only lists, reads, and
 * mutates manifests of projects that already exist.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  AUTOMATION_HANDLER_FILE,
  AUTOMATION_MANIFEST_FILE,
  AutomationManifestError,
  isValidAutomationId,
  parseManifest,
  type AutomationManifest,
} from './automation-manifest.js';

/**
 * A resolved automation project — the directory, its id, and the parsed
 * manifest, plus the few fields a scheduler host reads hoisted to the
 * top level.
 */
export interface AutomationRow {
  /** Directory name — the automation's stable id. */
  readonly id: string;
  /** Absolute path to the project directory. */
  readonly dir: string;
  /** Display name from the manifest. */
  readonly name: string;
  /** Cron expression from `manifest.trigger.expr`. */
  readonly cronExpr: string;
  /** User on/off toggle from the manifest. */
  readonly enabled: boolean;
  readonly manifest: AutomationManifest;
}

/** One project that failed to parse during a directory scan. */
export interface AutomationProjectError {
  readonly id: string;
  readonly error: string;
  readonly code?: string;
}

export interface ListAutomationProjectsResult {
  readonly rows: AutomationRow[];
  readonly errors: AutomationProjectError[];
}

function rowFrom(id: string, dir: string, manifest: AutomationManifest): AutomationRow {
  return {
    id,
    dir,
    name: manifest.name,
    cronExpr: manifest.trigger.expr,
    enabled: manifest.enabled,
    manifest,
  };
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

/** Absolute path to a project's manifest file. */
export function automationManifestPath(automationsDir: string, id: string): string {
  return path.join(automationsDir, id, AUTOMATION_MANIFEST_FILE);
}

/** Absolute path to a project's generated handler. */
export function automationHandlerPath(automationsDir: string, id: string): string {
  return path.join(automationsDir, id, AUTOMATION_HANDLER_FILE);
}

/**
 * Read one automation project. Returns `undefined` if the directory or
 * its `automation.json` is missing; throws `AutomationManifestError`
 * when the manifest exists but is invalid.
 */
export async function readAutomationProject(
  automationsDir: string,
  id: string,
): Promise<AutomationRow | undefined> {
  if (!isValidAutomationId(id)) return undefined;
  const dir = path.join(automationsDir, id);
  let raw: string;
  try {
    raw = await fs.readFile(automationManifestPath(automationsDir, id), 'utf8');
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw err;
  }
  let manifest: AutomationManifest;
  try {
    manifest = parseManifest(raw);
  } catch (err) {
    if (err instanceof AutomationManifestError) {
      throw new AutomationManifestError(err.code, `automations/${id}: ${err.message}`);
    }
    throw err;
  }
  return rowFrom(id, dir, manifest);
}

/**
 * Scan `<automationsDir>/*` and read every project's manifest. A
 * missing directory is "no automations" — an empty result. Projects
 * with an invalid manifest land in `errors` and don't block the rest.
 */
export async function listAutomationProjects(
  automationsDir: string,
): Promise<ListAutomationProjectsResult> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(automationsDir, { withFileTypes: true });
  } catch (err) {
    if (isEnoent(err)) return { rows: [], errors: [] };
    throw err;
  }
  const rows: AutomationRow[] = [];
  const errors: AutomationProjectError[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
    try {
      const row = await readAutomationProject(automationsDir, e.name);
      if (row) rows.push(row);
    } catch (err) {
      errors.push({
        id: e.name,
        error: err instanceof Error ? err.message : String(err),
        ...(err instanceof AutomationManifestError ? { code: err.code } : {}),
      });
    }
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return { rows, errors };
}

/** Overwrite a project's `automation.json` with `manifest`. */
export async function writeAutomationManifest(
  automationsDir: string,
  id: string,
  manifest: AutomationManifest,
): Promise<void> {
  await fs.writeFile(
    automationManifestPath(automationsDir, id),
    JSON.stringify(manifest, null, 2) + '\n',
  );
}

/**
 * Flip a project's `enabled` toggle in place. Returns the updated row,
 * or `undefined` when the project does not exist.
 */
export async function setAutomationEnabled(
  automationsDir: string,
  id: string,
  enabled: boolean,
): Promise<AutomationRow | undefined> {
  const row = await readAutomationProject(automationsDir, id);
  if (!row) return undefined;
  if (row.manifest.enabled === enabled) return row;
  const manifest: AutomationManifest = { ...row.manifest, enabled };
  await writeAutomationManifest(automationsDir, id, manifest);
  return rowFrom(id, row.dir, manifest);
}

/** Recursively remove an automation project directory. Idempotent. */
export async function deleteAutomationProject(automationsDir: string, id: string): Promise<void> {
  if (!isValidAutomationId(id)) return;
  await fs.rm(path.join(automationsDir, id), { recursive: true, force: true });
}
