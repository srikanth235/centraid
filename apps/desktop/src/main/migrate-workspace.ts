// One-shot migration from the pre-#108 layout.
//
// Before #108 the desktop wrote everything to `<projectsDir>/apps/<id>/`
// flat: source files, `data.sqlite`, run ledger. Now the workspace
// (source) lives at `<projectsDir>/workspace/<id>/` and the gateway
// storage (versioned + persistent data) stays at `<projectsDir>/apps/<id>/`.
//
// This module runs once on boot. For every flat-layout entry it finds
// under `<projectsDir>/apps/` — defined as "has no `current.json`" — it
// moves the source files into the workspace and leaves persistent state
// (`data.sqlite`, `runtime.sqlite`) behind. A subsequent `requestPublish`
// re-populates `current.json` + `versions/v_*/` from the workspace.
//
// Safety stance: when ANY ambiguity is detected (mixed flat + versioned,
// unreadable dirs, etc.), the entry is skipped with a console warning
// rather than risking data loss. Users can always migrate manually.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadSettings } from './settings.js';
import { requestPublish } from './publish-on-save.js';

/** Files / dirs that belong with the gateway storage, not the workspace. */
const STAY_IN_APPS_DIR = new Set([
  'data.sqlite',
  'data.sqlite-journal',
  'data.sqlite-wal',
  'data.sqlite-shm',
  'runtime.sqlite',
  'runtime.sqlite-journal',
  'runtime.sqlite-wal',
  'runtime.sqlite-shm',
  'current.json',
  'versions',
  '_uploads',
  '_trash',
  '_registry.json',
]);

/** Files / dirs that don't belong in either side (build artifacts, snapshots). */
const DROP = new Set(['node_modules', 'dist', '.preview', '.DS_Store']);

/**
 * Returns the set of project ids that were migrated this boot. Each
 * migrated app is queued for an immediate publish so the gateway picks up
 * the workspace as version v_1.
 */
export async function migrateLegacyFlatLayout(): Promise<string[]> {
  const { workspaceDir, appsDir } = await loadSettings();
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(appsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    console.warn(
      `[migrate-workspace] readdir ${appsDir} failed: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return [];
  }
  await fs.mkdir(workspaceDir, { recursive: true });

  const migrated: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
    const appDir = path.join(appsDir, e.name);
    const decision = await classify(appDir);
    if (decision === 'versioned') continue; // already migrated / new install
    if (decision === 'skip') {
      console.warn(`[migrate-workspace] skipping ${e.name}: ambiguous layout`);
      continue;
    }
    // decision === 'flat' — move source files to the workspace.
    const dest = path.join(workspaceDir, e.name);
    if (await pathExists(dest)) {
      console.warn(
        `[migrate-workspace] skipping ${e.name}: workspace target already exists at ${dest}`,
      );
      continue;
    }
    try {
      await migrateOne(appDir, dest);
      migrated.push(e.name);
      // Trigger initial publish so the workspace lands in `appsDir` as
      // a proper versioned upload. Immediate so the iframe + dispatcher
      // are functional on first interaction post-migration.
      requestPublish(e.name, { immediate: true });
    } catch (err) {
      console.warn(
        `[migrate-workspace] ${e.name} failed: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
  if (migrated.length > 0) {
    console.info(
      `[migrate-workspace] moved ${migrated.length} app(s) to workspace: ${migrated.join(', ')}`,
    );
  }
  return migrated;
}

async function classify(appDir: string): Promise<'flat' | 'versioned' | 'skip'> {
  const hasCurrent = await pathExists(path.join(appDir, 'current.json'));
  const hasVersions = await pathExists(path.join(appDir, 'versions'));
  // app.json at the top level is the source-of-truth marker for the flat
  // layout. Without it we can't tell what's there — leave it alone.
  const hasAppJson = await pathExists(path.join(appDir, 'app.json'));
  if (hasCurrent || hasVersions) return 'versioned';
  if (!hasAppJson) return 'skip';
  return 'flat';
}

async function migrateOne(srcAppDir: string, destWorkspaceDir: string): Promise<void> {
  await fs.mkdir(destWorkspaceDir, { recursive: true });
  const entries = await fs.readdir(srcAppDir, { withFileTypes: true });
  for (const e of entries) {
    if (DROP.has(e.name)) continue;
    if (STAY_IN_APPS_DIR.has(e.name)) continue;
    const from = path.join(srcAppDir, e.name);
    const to = path.join(destWorkspaceDir, e.name);
    // Rename is atomic within the same volume — `<projectsDir>/apps`
    // and `<projectsDir>/workspace` are siblings, so this should
    // always succeed. If it ever fails (cross-device link, locked
    // file), fall back to copy + unlink.
    try {
      await fs.rename(from, to);
    } catch {
      await fs.cp(from, to, { recursive: true });
      await fs.rm(from, { recursive: true, force: true });
    }
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
