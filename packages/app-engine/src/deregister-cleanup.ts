import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RegistryEntry } from './types.js';

export interface DeregisterLogger {
  warn(message: string): void;
}

/**
 * Result of attempting to clean an app's wrapper dir on deregister.
 * Used by tests; the production handler just calls and logs.
 */
export type CleanupOutcome =
  | { kind: 'removed' }
  | { kind: 'skipped'; reason: 'outside-appsdir' }
  | { kind: 'failed'; error: Error };

/**
 * Remove an app's wrapper dir (`<appsDir>/<id>/`) after the registry
 * entry has been dropped. The defense-in-depth check ensures
 * `entry.path` resolves inside `appsDir` before we recursively delete —
 * a corrupt registry row with an absolute path elsewhere on disk must
 * not wipe anything outside our state.
 */
export async function cleanupDeregisteredApp(
  appsDir: string,
  entry: RegistryEntry,
  logger: DeregisterLogger,
): Promise<CleanupOutcome> {
  const rel = path.relative(appsDir, entry.path);
  const insideAppsDir = !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && rel.length > 0;
  if (!insideAppsDir) {
    logger.warn(`[centraid] deregister: refusing to remove "${entry.path}" — outside appsDir`);
    return { kind: 'skipped', reason: 'outside-appsdir' };
  }
  try {
    await fs.rm(entry.path, { recursive: true, force: true });
    return { kind: 'removed' };
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    logger.warn(`[centraid] deregister: failed to remove "${entry.path}": ${e.message}`);
    return { kind: 'failed', error: e };
  }
}
