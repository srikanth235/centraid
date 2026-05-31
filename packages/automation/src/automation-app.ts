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
 * `<appCodeDir>` is an app's *active version* directory. `listAutomations`
 * resolves it per app via `readActiveCodeDir` — that returns
 * `<appDir>/versions/<active>/` for an uploaded/versioned app and falls
 * back to `<appDir>` itself for a flat, editable desktop app. The
 * same scan therefore covers both the gateway (versioned) and the
 * desktop builder (flat draft).
 *
 * An automation's globally-unique handle is `<appId>/<id>` — see
 * `formatAutomationRef`. Scaffolding a fresh app lives in
 * `@centraid/agent-harness`; this module lists, reads, and mutates
 * manifests of apps that already exist.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readActiveCodeDir } from '@centraid/app-engine';
import {
  AUTOMATION_HANDLER_FILE,
  AUTOMATION_MANIFEST_FILE,
  AutomationManifestError,
  parseManifest,
  type AutomationManifest,
  type AutomationTrigger,
} from './automation-manifest.js';
import { formatAutomationRef, isValidAutomationId } from './automation-ref.js';

/** Subdirectory under an app's code dir that holds the app's automations. */
export const APP_AUTOMATIONS_SUBDIR = 'automations';

/**
 * A resolved automation app — the directory, its id, the owning app,
 * and the parsed manifest, plus the few fields a scheduler host reads
 * hoisted to the top level.
 */
export interface AutomationRow {
  /** Directory name — the automation's id, unique within its app. */
  readonly id: string;
  /** Absolute path to the automation app directory. */
  readonly dir: string;
  /** Display name from the manifest. */
  readonly name: string;
  /** Trigger list hoisted from `manifest.triggers`. */
  readonly triggers: readonly AutomationTrigger[];
  /** User on/off toggle from the manifest. */
  readonly enabled: boolean;
  /** Id of the app folder this automation belongs to. */
  readonly ownerApp: string;
  /** Globally-unique handle — `<ownerApp>/<id>`. */
  readonly ref: string;
  readonly manifest: AutomationManifest;
}

/** One app that failed to parse during a directory scan. */
export interface AutomationAppError {
  /** `<appId>/<automationId>` of the app that failed to parse. */
  readonly id: string;
  readonly error: string;
  readonly code?: string;
}

export interface ListAutomationAppsResult {
  readonly rows: AutomationRow[];
  readonly errors: AutomationAppError[];
}

function rowFrom(
  id: string,
  dir: string,
  manifest: AutomationManifest,
  ownerApp: string,
): AutomationRow {
  return {
    id,
    dir,
    name: manifest.name,
    triggers: manifest.triggers,
    enabled: manifest.enabled,
    ownerApp,
    ref: formatAutomationRef(ownerApp, id),
    manifest,
  };
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

/** Absolute path to an automation app's manifest file. */
export function automationManifestPath(automationDir: string): string {
  return path.join(automationDir, AUTOMATION_MANIFEST_FILE);
}

/** Absolute path to an automation app's generated handler. */
export function automationHandlerPath(automationDir: string): string {
  return path.join(automationDir, AUTOMATION_HANDLER_FILE);
}

/**
 * Read one automation app from an explicit app directory. The
 * id is the directory basename; `ownerApp` is the owning app's id.
 * Returns `undefined` if the directory or its `automation.json` is
 * missing; throws `AutomationManifestError` when the manifest exists but
 * is invalid.
 */
export async function readAutomationAppAt(
  dir: string,
  ownerApp: string,
): Promise<AutomationRow | undefined> {
  const id = path.basename(dir);
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, AUTOMATION_MANIFEST_FILE), 'utf8');
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw err;
  }
  let manifest: AutomationManifest;
  try {
    manifest = parseManifest(raw);
  } catch (err) {
    if (err instanceof AutomationManifestError) {
      throw new AutomationManifestError(err.code, `${ownerApp}/${id}: ${err.message}`);
    }
    throw err;
  }
  return rowFrom(id, dir, manifest, ownerApp);
}

/**
 * Resolve one app-owned automation by `(appId, automationId)`, reading
 * from the app's *active version* code dir. Returns `undefined` when the
 * app, the automation directory, or its `automation.json` is missing;
 * throws `AutomationManifestError` when the manifest is invalid.
 */
export async function readAppOwnedAutomation(
  appsDir: string,
  appId: string,
  automationId: string,
): Promise<AutomationRow | undefined> {
  if (!isValidAutomationId(automationId)) return undefined;
  const codeDir = await readActiveCodeDir(path.join(appsDir, appId));
  return readAutomationAppAt(path.join(codeDir, APP_AUTOMATIONS_SUBDIR, automationId), appId);
}

/**
 * The full automation registry: scan every app folder under `appsDir`,
 * resolve its active-version code dir, and read every automation under
 * `<codeDir>/automations/`. A missing `appsDir`, or an app with no
 * `automations/` subdir, contributes nothing. Apps with an invalid
 * manifest land in `errors` and don't block the rest.
 */
export async function listAutomations(appsDir: string): Promise<ListAutomationAppsResult> {
  let appEntries: import('node:fs').Dirent[];
  try {
    appEntries = await fs.readdir(appsDir, { withFileTypes: true });
  } catch (err) {
    if (isEnoent(err)) return { rows: [], errors: [] };
    throw err;
  }
  const rows: AutomationRow[] = [];
  const errors: AutomationAppError[] = [];
  for (const app of appEntries) {
    if (!app.isDirectory()) continue;
    if (app.name.startsWith('.') || app.name.startsWith('_')) continue;
    const codeDir = await readActiveCodeDir(path.join(appsDir, app.name));
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
        const row = await readAutomationAppAt(path.join(autoRoot, e.name), app.name);
        if (row) rows.push(row);
      } catch (err) {
        errors.push({
          id: `${app.name}/${e.name}`,
          error: err instanceof Error ? err.message : String(err),
          ...(err instanceof AutomationManifestError ? { code: err.code } : {}),
        });
      }
    }
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return { rows, errors };
}

/** Overwrite the `automation.json` in an explicit app directory. */
export async function writeAutomationManifestAt(
  dir: string,
  manifest: AutomationManifest,
): Promise<void> {
  await fs.writeFile(
    path.join(dir, AUTOMATION_MANIFEST_FILE),
    JSON.stringify(manifest, null, 2) + '\n',
  );
}

/**
 * Flip an automation's `enabled` toggle in place. `dir` is the app
 * directory, `ownerApp` its owning app id. Returns the updated row, or
 * `undefined` when the app does not exist.
 */
export async function setAutomationEnabledAt(
  dir: string,
  ownerApp: string,
  enabled: boolean,
): Promise<AutomationRow | undefined> {
  const row = await readAutomationAppAt(dir, ownerApp);
  if (!row) return undefined;
  if (row.manifest.enabled === enabled) return row;
  const manifest: AutomationManifest = { ...row.manifest, enabled };
  await writeAutomationManifestAt(dir, manifest);
  return rowFrom(row.id, dir, manifest, ownerApp);
}

/** Recursively remove an automation app directory. Idempotent. */
export async function deleteAutomationAt(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}
