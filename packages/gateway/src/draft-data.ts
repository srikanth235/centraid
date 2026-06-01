// Draft data seeding for schema-safe editing (issue #144).
//
// A draft's `data.sqlite` lives inside the session worktree, next to the
// code the agent edits. It is seeded lazily — on first draft access — by
// copying the app's live `data.sqlite` (`VACUUM INTO`, which preserves
// `PRAGMA user_version` and copies rows) and then replaying the draft's
// pending (unpublished) migrations on top. A seeded copy therefore starts
// at live's schema version, and replaying applies only the draft's *new*
// migrations — exercising a pending migration against real prod data
// before publish (the publish "dress rehearsal").
//
// The composition root owns this: it's the one layer that sees both the
// live data path and the session worktree. `WorktreeStore.init()` gitignores
// the draft `data.sqlite` (+ WAL/SHM), so this copy is never staged by
// publish and is discarded with the worktree on close.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runPendingMigrations } from '@centraid/app-engine';
import type { WorktreeStore } from '@centraid/worktree-store';

const DATA_FILE = 'data.sqlite';
const SIDECARS = ['data.sqlite-wal', 'data.sqlite-shm'];

export interface SeedDraftDataResult {
  /** False when an existing draft copy was reused (no force) — a no-op. */
  seeded: boolean;
  /** Ids of pending migrations replayed onto the seeded copy this run. */
  migrationsApplied: number[];
}

/**
 * Ensure the session worktree's `apps/<appId>/data.sqlite` exists, seeded
 * from the app's live data + the draft's pending migrations.
 *
 * Idempotent: a no-op (returns `{ seeded: false }`) when the draft copy
 * already exists, unless `force` re-seeds it from a fresh prod snapshot
 * (the preview "Reset data from prod" control). Throws `MigrationError` if a
 * pending migration fails against the prod-seeded rows — surfacing the
 * publish conflict in preview.
 */
export async function seedDraftData(opts: {
  /** App's live `data.sqlite` (`<appsDir>/<appId>/data.sqlite`). */
  liveDataFile: string;
  /** Session worktree's `apps/<appId>/` dir, where the draft copy lands. */
  worktreeAppDir: string;
  /** Drop any existing draft copy and re-seed from a fresh prod snapshot. */
  force?: boolean;
}): Promise<SeedDraftDataResult> {
  const draftFile = path.join(opts.worktreeAppDir, DATA_FILE);
  if (opts.force) {
    await removeDraftDb(opts.worktreeAppDir);
  } else if (await pathExists(draftFile)) {
    return { seeded: false, migrationsApplied: [] };
  }

  // Copy live → draft. `VACUUM INTO` reads the source and writes a fresh,
  // defragmented copy (preserving `user_version`); the target must not yet
  // exist, which the guard above ensures. A brand-new app with no live data
  // skips the copy and seeds from an empty DB the migration run creates.
  if (await pathExists(opts.liveDataFile)) {
    const db = new DatabaseSync(opts.liveDataFile);
    try {
      db.exec(`VACUUM INTO ${sqlStringLiteral(draftFile)}`);
    } finally {
      db.close();
    }
  }

  // Replay the draft's pending (unpublished) migrations on top of the seeded
  // copy — applies only ids greater than the snapshot's user_version. If a
  // migration fails, delete the half-seeded copy so seeding isn't treated as
  // complete: the next access re-seeds from scratch rather than previewing
  // against a copied-but-unmigrated DB.
  let out;
  try {
    out = await runPendingMigrations(opts.worktreeAppDir, draftFile);
  } catch (err) {
    await removeDraftDb(opts.worktreeAppDir);
    throw err;
  }
  return { seeded: true, migrationsApplied: out.applied };
}

/**
 * Build the runtime's draft code-dir resolver: resolve an app's code dir to
 * its OPEN session worktree and lazily seed the draft `data.sqlite` there
 * before returning (issue #144). In draft mode data dir = code dir, so this
 * one resolver primes both planes. Returns `undefined` for an unknown/closed
 * session (→ the runtime serves a 503), leaving the live path unaffected. A
 * seed-time migration failure propagates (→ 500 with the SQL error) rather
 * than masquerading as a missing session.
 */
export function makeDraftCodeDirResolver(
  store: WorktreeStore,
  liveDataFile: (appId: string) => string,
): (appId: string, sessionId: string) => Promise<string | undefined> {
  return async (appId, sessionId) => {
    let worktreeAppDir: string;
    try {
      worktreeAppDir = await store.snapshotSessionAppDir(sessionId, appId);
    } catch {
      return undefined;
    }
    await seedDraftData({ liveDataFile: liveDataFile(appId), worktreeAppDir });
    return worktreeAppDir;
  };
}

/** Remove the draft `data.sqlite` and its WAL/SHM sidecars (best-effort). */
async function removeDraftDb(worktreeAppDir: string): Promise<void> {
  for (const name of [DATA_FILE, ...SIDECARS]) {
    await fs.rm(path.join(worktreeAppDir, name), { force: true });
  }
}

/** Single-quoted SQL string literal with embedded quotes doubled. */
function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
