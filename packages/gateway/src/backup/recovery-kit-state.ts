/*
 * The recovery-kit confirmation flag, generalized to gateway level (issue
 * #367 §C10). Wave 4 (#351) introduced `recoveryKit.confirmedAt` inside
 * `backup-state.ts`'s `BackupState` — but that file only exists once a
 * `backup` config block is configured, so a vault's CAS remote tier (which
 * needs the SAME nudge — "have you exported and safely stored your recovery
 * kit?" — before it starts shipping bytes off-box) had nothing to read.
 *
 * This store is the single source of truth now: one JSON file
 * (`<dir>/recovery-kit.json`) at the gateway level, independent of whether
 * backup is configured. `BackupService` (backup-service.ts) is wired to
 * THIS store by `build-gateway.ts` — `backup-routes.ts`'s `recoveryKit`
 * field keeps reading through `BackupService.recoveryKitStatus()`
 * unchanged, so the Backup card's behavior doesn't move; it's just reading
 * the same fact from a location that no longer requires backup to exist.
 *
 * Same atomic-write shape as `backup-state.ts` / `storage-connections.ts`.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface RecoveryKitState {
  /** Epoch SECONDS the operator last confirmed, or `null` if never. */
  confirmedAt: number | null;
}

function stateFile(dir: string): string {
  return path.join(dir, 'recovery-kit.json');
}

export async function loadRecoveryKitState(dir: string): Promise<RecoveryKitState> {
  try {
    const raw = await fs.readFile(stateFile(dir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<RecoveryKitState>;
    return { confirmedAt: typeof parsed.confirmedAt === 'number' ? parsed.confirmedAt : null };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return { confirmedAt: null };
  }
}

export async function saveRecoveryKitState(dir: string, state: RecoveryKitState): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const file = stateFile(dir);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
}

/** Thin object wrapper (constructor-injectable) — `BackupService` and the storage routes share one instance. */
export class RecoveryKitStateStore {
  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  status(): Promise<RecoveryKitState> {
    return loadRecoveryKitState(this.dir);
  }

  /** One-way: confirming again just refreshes the timestamp. */
  async confirm(): Promise<RecoveryKitState> {
    const state: RecoveryKitState = { confirmedAt: Math.floor(this.now() / 1000) };
    await saveRecoveryKitState(this.dir, state);
    return state;
  }
}
