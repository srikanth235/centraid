/**
 * Sync the on-disk `automations/*.json` for one app into the gateway's
 * `automations` mirror table. This is the deploy boundary: every path
 * that lands new code in an app calls this so the mirror reflects what
 * the user just deployed.
 *
 * Wired in two places today:
 *   - `handleAppUpload` (runtime-core) — after a tarball lands + migrations
 *     run, the just-extracted version's manifests get synced. Covers both
 *     remote (openclaw gateway) and local (desktop in-process gateway)
 *     publish paths since they share the same upload handler.
 *   - Hosts can also call directly for out-of-band syncs (tests, a
 *     "Refresh" button, etc.).
 *
 * Semantics:
 *   - Each `<appCodeDir>/automations/*.json` is parsed + validated. Files
 *     that fail validation are reported in `errors` and skipped — the
 *     other manifests still apply.
 *   - The `enabled` flag is preserved from any existing mirror row, so a
 *     user toggle survives republish. New manifests default to enabled.
 *   - Manifests removed from disk are deleted from the mirror.
 *
 * Reconciliation with the host scheduler (openclaw cron, OS scheduler)
 * is the caller's job — sync returns the diff and an optional
 * `onSynced` hook lets the host fire its reconciler when the mirror
 * actually changed.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  AutomationManifestError,
  parseManifest,
  type AutomationManifest,
} from './automation-manifest.js';
import type { AutomationRow, AutomationStore } from './automation-store.js';

export interface SyncAutomationsOptions {
  /** App id the manifests belong to. */
  appId: string;
  /** Directory containing the `automations/` subfolder for this app. */
  appCodeDir: string;
  /** Mirror store to write into. */
  store: AutomationStore;
}

export interface SyncAutomationError {
  /** Relative path under `automations/`, e.g. `weekly-recap.json`. */
  file: string;
  /** Human-readable error. `AutomationManifestError.code` when applicable. */
  error: string;
  code?: string;
}

export interface SyncAutomationsResult {
  /** Automation names newly inserted into the mirror. */
  added: string[];
  /** Automation names whose manifest changed (prompt, schedule, action, requires, …). */
  updated: string[];
  /** Automation names removed because the on-disk file disappeared. */
  removed: string[];
  /** Automation names whose mirror row already matched the on-disk manifest. */
  unchanged: string[];
  /** Files that failed to parse or validate — the other entries still applied. */
  errors: SyncAutomationError[];
}

/**
 * Scan `<appCodeDir>/automations/*.json`, upsert valid manifests into
 * the mirror, and remove rows whose file disappeared. Idempotent.
 *
 * Missing `automations/` folder is treated as "no automations" — common
 * for older app templates and for apps the user hasn't added an
 * automation to yet. Returns an empty diff in that case (and clears any
 * stale mirror rows for the app).
 */
export async function syncAutomationsFromDisk(
  opts: SyncAutomationsOptions,
): Promise<SyncAutomationsResult> {
  const { appId, appCodeDir, store } = opts;
  const automationsDir = path.join(appCodeDir, 'automations');

  const result: SyncAutomationsResult = {
    added: [],
    updated: [],
    removed: [],
    unchanged: [],
    errors: [],
  };

  const filenames = await readAutomationFilenames(automationsDir);
  const existingRows = store.listByApp(appId);
  const existingByName = new Map(existingRows.map((r) => [r.name, r]));

  const seenNames = new Set<string>();
  for (const filename of filenames) {
    const name = filename.slice(0, -'.json'.length);
    seenNames.add(name);

    let manifest: AutomationManifest;
    try {
      const raw = await fs.readFile(path.join(automationsDir, filename), 'utf8');
      manifest = parseManifest(raw);
    } catch (err) {
      result.errors.push(toSyncError(filename, err));
      continue;
    }

    const prev = existingByName.get(name);
    // Preserve the user's enable/disable toggle across republish. New
    // manifests default to enabled so an automation the agent just
    // scaffolded runs without an extra confirm step.
    const enabled = prev ? prev.enabled : true;

    if (prev && manifestEquals(prev.manifest, manifest) && prev.enabled === enabled) {
      result.unchanged.push(name);
      continue;
    }

    store.upsert(appId, name, manifest, enabled);
    if (prev) result.updated.push(name);
    else result.added.push(name);
  }

  for (const row of existingRows) {
    if (seenNames.has(row.name)) continue;
    store.remove(appId, row.name);
    result.removed.push(row.name);
  }

  return result;
}

async function readAutomationFilenames(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  return entries.filter((n) => n.endsWith('.json')).sort();
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

function toSyncError(file: string, err: unknown): SyncAutomationError {
  if (err instanceof AutomationManifestError) {
    return { file, error: err.message, code: err.code };
  }
  return { file, error: err instanceof Error ? err.message : String(err) };
}

/**
 * Deep-equal two manifests for the fields we mirror. JSON.stringify is
 * fine because every field is serializable and ordering in the canonical
 * form is stable (the validator builds the object in the same key
 * order — both reads + writes go through `parseManifest`).
 */
function manifestEquals(a: AutomationManifest, b: AutomationManifest): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Re-export so a host receiving a sync result has the row type to hand. */
export type { AutomationRow };
