import path from 'node:path';
import type { RegistryEntry } from '../types.js';

/**
 * Resolve where an app's persistent data file lives.
 *
 * For uploaded apps the data file is at `<appsDir>/<id>/data.sqlite` —
 * outside any version dir, so it survives version swaps.
 *
 * For path-registered apps the data file is at `<path>/data.sqlite` —
 * the external folder is the data root.
 */
export function appDataDir(entry: RegistryEntry): string {
  return entry.path;
}

/**
 * Resolve where the active *code* lives (handlers + static + app.json + crons).
 *
 * For uploaded apps this is `<path>/versions/<activeVersion>/`.
 * For path-registered apps this is just `<path>` itself.
 *
 * The `activeVersion` for uploaded apps is read from `current.json` by the
 * caller (typically `VersionStore.getActiveVersion`).
 */
export function appCodeDir(entry: RegistryEntry, activeVersion?: string): string {
  if (entry.mode === 'uploaded') {
    if (!activeVersion) {
      throw new AppPathError(
        'no_active_version',
        `App "${entry.id}" is uploaded mode but has no active version.`,
      );
    }
    return path.join(entry.path, 'versions', activeVersion);
  }
  return entry.path;
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
