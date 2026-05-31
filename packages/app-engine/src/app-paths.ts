import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { RegistryEntry } from './types.js';

/**
 * Validate an app folder id. A filesystem-safe slug — alnum / `-` / `_`,
 * no path separators, no dots, and no `_`-prefixed (plugin-internal) ids.
 * Automation apps are no longer distinguished by a dotted `auto.` prefix
 * (that is now the manifest's `kind` field), so the id grammar is a plain
 * slug again and `..` is impossible by construction.
 *
 * This is general app-identity — shared by the agent-run ledger
 * (`chat-history`), the automation domain (`automation-ref`,
 * `scaffold-automation`), and anything else that keys on an app folder.
 */
export function isValidAppId(id: string): boolean {
  if (typeof id !== 'string' || id.length === 0) return false;
  if (id.startsWith('_')) return false;
  return /^[A-Za-z0-9_-]+$/.test(id);
}

/**
 * Resolve where an app's persistent data file lives.
 *
 * Every app's data file is at `<appsDir>/<id>/data.sqlite` — outside
 * any version dir, so it survives version swaps.
 */
export function appDataDir(entry: RegistryEntry): string {
  return entry.path;
}

/**
 * Resolve where the active *code* lives (handlers + static + app.json):
 * `<path>/versions/<activeVersion>/`. The `activeVersion` is read from
 * `current.json` by the caller (typically `VersionStore.getActiveVersion`).
 */
export function appCodeDir(entry: RegistryEntry, activeVersion: string): string {
  if (!activeVersion) {
    throw new AppPathError('no_active_version', `App "${entry.id}" has no active version.`);
  }
  return path.join(entry.path, 'versions', activeVersion);
}

/**
 * Resolve an uploaded app's active code dir from disk, given only the
 * persistent app root. Reads `<appDir>/current.json`, finds the
 * `activeVersion`, and returns `<appDir>/versions/<activeVersion>/`.
 *
 * Falls back to `appDir` itself when `current.json` is missing or has
 * no active version — that covers path-registered apps (flat layout)
 * and dev-project layouts the centraid CLI is run inside.
 *
 * Used by callers that have the persistent root in hand but need the
 * code root (handlers + automation manifests live there). Two
 * concrete callers today:
 *   - the desktop's Run-now IPC (renderer triggers immediate fire)
 *   - the centraid CLI's `run-automation` subcommand (fires under the
 *     OS scheduler, whose `cwd` is frozen to the persistent root at
 *     register time and must not change across publishes)
 */
export async function readActiveCodeDir(appDir: string): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(appDir, 'current.json'), 'utf8');
    const parsed = JSON.parse(raw) as { activeVersion?: unknown };
    if (typeof parsed.activeVersion === 'string' && parsed.activeVersion.length > 0) {
      return path.join(appDir, 'versions', parsed.activeVersion);
    }
  } catch {
    // Missing/unreadable current.json — flat layout (path-registered or dev).
  }
  return appDir;
}

export class AppPathError extends Error {
  constructor(
    public readonly code: 'no_active_version',
    message: string,
  ) {
    super(message);
    this.name = 'AppPathError';
  }
}
