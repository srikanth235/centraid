/**
 * Sync a user's on-disk `automations/*.json` manifests into the
 * `automations` table.
 *
 * Model-B (issue #90): automations are user-owned, not app-scoped. The
 * manifests live in one global directory per user (not inside an app's
 * source tree), so this is a single global scan rather than a per-app
 * deploy step. The `enabled` toggle is a column on the `automations`
 * row itself — sync preserves it across rescans.
 *
 * Wired at host startup (and callable on demand — a "Refresh" button,
 * tests). Reconciliation with the host scheduler (openclaw cron, OS
 * scheduler) is the caller's job — sync returns the diff.
 *
 * Semantics:
 *   - Each `<automationsDir>/*.json` is parsed + validated. Files that
 *     fail validation are reported in `errors` and skipped — the other
 *     manifests still apply.
 *   - An existing row keeps its UUID and its `enabled` flag across a
 *     rescan; only the manifest content is refreshed.
 *   - Manifests removed from disk are deleted from the table.
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
  /** User the manifests belong to. */
  userId: string;
  /** Directory holding this user's `*.json` automation manifests. */
  automationsDir: string;
  /** Store to write into. */
  store: AutomationStore;
}

export interface SyncAutomationError {
  /** Manifest filename, e.g. `weekly-recap.json`. */
  file: string;
  /** Human-readable error. `AutomationManifestError.code` when applicable. */
  error: string;
  code?: string;
}

export interface SyncAutomationsResult {
  /** Automation names newly inserted. */
  added: string[];
  /** Automation names whose manifest changed. */
  updated: string[];
  /** Automation names removed because the on-disk file disappeared. */
  removed: string[];
  /** Automation names whose row already matched the on-disk manifest. */
  unchanged: string[];
  /** Files that failed to parse or validate — the other entries still applied. */
  errors: SyncAutomationError[];
}

/**
 * Scan `<automationsDir>/*.json`, upsert valid manifests, and remove
 * rows whose file disappeared. Idempotent.
 *
 * Missing directory is treated as "no automations" — returns an empty
 * diff (and clears any stale rows for the user).
 */
export async function syncAutomationsFromDisk(
  opts: SyncAutomationsOptions,
): Promise<SyncAutomationsResult> {
  const { userId, automationsDir, store } = opts;

  const result: SyncAutomationsResult = {
    added: [],
    updated: [],
    removed: [],
    unchanged: [],
    errors: [],
  };

  const filenames = await readAutomationFilenames(automationsDir);
  const existingRows = store.listByUser(userId);
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
    // An existing row keeps the user's `enabled` toggle; a brand-new
    // manifest defaults to enabled.
    const enabled = prev ? prev.enabled : true;

    if (prev && manifestEquals(prev.manifest, manifest)) {
      result.unchanged.push(name);
      continue;
    }

    store.upsert(userId, name, manifest, enabled);
    if (prev) result.updated.push(name);
    else result.added.push(name);
  }

  for (const row of existingRows) {
    if (seenNames.has(row.name)) continue;
    store.remove(row.id);
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
