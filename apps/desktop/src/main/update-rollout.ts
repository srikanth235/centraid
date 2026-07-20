/*
 * Staged-rollout wiring (issue #468, I5/I6).
 *
 * Thin Electron-facing surface over `update-rollout-core.ts`. The real
 * auto-updater state machine (I4) will call into here; until then the
 * unpackaged dev loop keeps using `update-watcher.ts` (dist mtime poll).
 *
 * Persists a stable per-install bucket id under userData so the time ramp
 * is not re-rolled every check.
 */

import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROLLOUT_WINDOW_MS, shouldAdmitUpdate, stableBucketId } from './update-rollout-core.js';

export { ROLLOUT_WINDOW_MS, shouldAdmitUpdate, stableBucketId } from './update-rollout-core.js';

const INSTALL_ID_FILE = 'install-id';

/** Resolve (or mint) the stable install id used for rollout bucketing. */
export async function getOrCreateInstallId(): Promise<string> {
  const file = path.join(app.getPath('userData'), INSTALL_ID_FILE);
  try {
    const existing = (await fs.readFile(file, 'utf8')).trim();
    if (existing.length > 0) return existing;
  } catch {
    // mint below
  }
  const id = randomUUID();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, id, { mode: 0o600 });
  return id;
}

/** Stable bucket in [0, 1) for this install. */
export async function getInstallRolloutBucket(): Promise<number> {
  return stableBucketId(await getOrCreateInstallId());
}

/**
 * Whether this install should take an available update under the 72h ramp.
 * `manualCheck: true` always admits (Settings → Check for updates).
 */
export async function admitUpdate(input: {
  releasedAtMs?: number | null;
  nowMs?: number;
  manualCheck?: boolean;
  windowMs?: number;
}): Promise<boolean> {
  const bucket = await getInstallRolloutBucket();
  return shouldAdmitUpdate({
    bucket,
    releasedAtMs: input.releasedAtMs,
    nowMs: input.nowMs ?? Date.now(),
    ...(input.windowMs !== undefined ? { windowMs: input.windowMs } : {}),
    ...(input.manualCheck !== undefined ? { manualCheck: input.manualCheck } : {}),
  });
}
