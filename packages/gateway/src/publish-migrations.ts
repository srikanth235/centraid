// Migrations-on-publish for the git-store backend (issue #144).
//
// The pure git store (`@centraid/worktree-store`) only commits + ff-merges
// *code* on publish — it never touches `data.sqlite`. So under the
// git-store backend a published schema change never reached live data;
// `runPendingMigrations` was wired only into the legacy tarball-upload
// path (`app-engine/route-handlers.ts`). This module is the gateway-side
// fix: the composition root is the one layer that sees both the session
// worktree (which carries `migrations/`) and the live data path, so it
// runs the committed migrations against live `data.sqlite` here.
//
// The store stays pure — it knows nothing about SQLite or live data
// paths; the gateway passes the live path in, symmetric to how it
// injects the draft code-dir resolver.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runPendingMigrations } from '@centraid/app-engine';

/**
 * Run an app's pending migrations against its LIVE `data.sqlite` as part
 * of a publish.
 *
 * `worktreeAppDir` is the session worktree's `apps/<appId>/` dir (the
 * about-to-publish code), which carries `migrations/`; `liveDataFile` is
 * the stable live `<appsDir>/<appId>/data.sqlite`. Call this BEFORE the
 * ff-merge — mirroring the legacy migrate-then-commit ordering — so a
 * migration incompatible with live rows fails inside `BEGIN IMMEDIATE`,
 * rolls back, and aborts the publish with the SQL error, live data
 * untouched.
 *
 * Returns the ids of migrations newly applied this run (empty when the
 * schema was already current). Throws `MigrationError` on a bad migration
 * set or a failing statement — the caller maps it to its error surface.
 */
export async function runPublishMigrations(
  worktreeAppDir: string,
  liveDataFile: string,
): Promise<number[]> {
  // A brand-new app's first publish has no live data dir yet — the
  // registry's `ensureUploaded` only runs post-publish. Create the parent
  // so `runPendingMigrations` (which opens/creates the DB file) can plant
  // the schema from an empty start.
  await fs.mkdir(path.dirname(liveDataFile), { recursive: true });
  const out = await runPendingMigrations(worktreeAppDir, liveDataFile);
  return out.applied;
}
