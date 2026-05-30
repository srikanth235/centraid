import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * SQL migration runner for centraid apps.
 *
 * Each app's `migrations/` directory contains files named `NNNN_<slug>.sql`
 * (zero-padded id, contiguous from `0001`). On every publish the plugin runs
 * any migrations whose id is greater than `PRAGMA user_version`, all in a
 * single transaction. Already-applied migrations are skipped, so the same
 * files re-ship in every tarball forever.
 *
 * Hard rule (enforced in the agent system prompt, not here): once a
 * migration is published it must never be edited. Fix-forward with a new
 * higher-numbered file.
 */

export interface MigrationsApplied {
  /** Ids of migrations newly applied this run, in order. */
  applied: number[];
  /** `PRAGMA user_version` after the run completes. */
  finalUserVersion: number;
}

export class MigrationError extends Error {
  constructor(
    public readonly code: 'bad_name' | 'gap' | 'duplicate' | 'sql_failed',
    message: string,
    public readonly file?: string,
    public readonly sqlError?: string,
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

const NAME_RE = /^(\d{4})_([a-z0-9][a-z0-9_-]*)\.sql$/;

interface MigrationFile {
  id: number;
  file: string;
  fullPath: string;
}

/**
 * Apply pending migrations from `<extractedDir>/migrations/` to `dataDbFile`.
 *
 * Behavior:
 *   - Returns `{ applied: [], finalUserVersion: <current> }` if no
 *     `migrations/` dir exists or it is empty.
 *   - Validates every entry as `NNNN_<slug>.sql`, ids contiguous from 1, no
 *     duplicates. Any violation throws `MigrationError`.
 *   - Reads `PRAGMA user_version`; runs only migrations with id > that.
 *   - All pending migrations execute inside a single `BEGIN IMMEDIATE` /
 *     `COMMIT` transaction. Any SQL error rolls back the whole batch and
 *     `user_version` stays untouched.
 *   - On success, `user_version` is set to the highest applied id.
 *
 * The caller is expected to discard the extracted directory (and abort the
 * publish) on any thrown `MigrationError`.
 */
export async function runPendingMigrations(
  extractedDir: string,
  dataDbFile: string,
): Promise<MigrationsApplied> {
  const migrationsDir = path.join(extractedDir, 'migrations');
  const candidates = await collectMigrations(migrationsDir);

  // Open the DB even when there's nothing to do — we still need to report the
  // current `user_version`, and opening creates the file if it doesn't exist
  // (which is the desired behavior for a brand-new app's first publish).
  const db = new DatabaseSync(dataDbFile);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    // Wait up to 30s for any concurrent writer (an in-flight handler holding
    // a write lock) to release before bailing on a migration.
    db.exec('PRAGMA busy_timeout = 30000');

    const currentVersion = readUserVersion(db);
    const pending = candidates.filter((c) => c.id > currentVersion);
    if (pending.length === 0) {
      return { applied: [], finalUserVersion: currentVersion };
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const m of pending) {
        const sql = await fs.readFile(m.fullPath, 'utf8');
        try {
          db.exec(sql);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new MigrationError('sql_failed', `migration ${m.file} failed: ${msg}`, m.file, msg);
        }
      }
      const lastId = pending[pending.length - 1]!.id;
      // PRAGMA does not accept bind params; lastId comes from the validated
      // /^\d{4}$/ filename match so it's safe to interpolate.
      db.exec(`PRAGMA user_version = ${lastId}`);
      db.exec('COMMIT');
      return { applied: pending.map((p) => p.id), finalUserVersion: lastId };
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* the transaction already aborted — nothing to roll back */
      }
      throw err;
    }
  } finally {
    try {
      db.close();
    } catch {
      /* best effort */
    }
  }
}

async function collectMigrations(migrationsDir: string): Promise<MigrationFile[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(migrationsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  if (entries.length === 0) return [];

  const byId = new Map<number, MigrationFile>();
  for (const name of entries) {
    const m = NAME_RE.exec(name);
    if (!m) {
      throw new MigrationError('bad_name', `migration "${name}" must match NNNN_<slug>.sql`, name);
    }
    const id = Number.parseInt(m[1]!, 10);
    if (id < 1) {
      throw new MigrationError('bad_name', `migration "${name}" must have id >= 0001`, name);
    }
    const existing = byId.get(id);
    if (existing) {
      throw new MigrationError(
        'duplicate',
        `migrations "${existing.file}" and "${name}" share id ${id}`,
        name,
      );
    }
    byId.set(id, { id, file: name, fullPath: path.join(migrationsDir, name) });
  }

  const sorted = [...byId.values()].sort((a, b) => a.id - b.id);
  for (let i = 0; i < sorted.length; i++) {
    const expected = i + 1;
    if (sorted[i]!.id !== expected) {
      const padded = String(expected).padStart(4, '0');
      throw new MigrationError(
        'gap',
        `migration ids must be contiguous from 0001; missing ${padded}`,
        sorted[i]!.file,
      );
    }
  }
  return sorted;
}

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}
