/*
 * Per-gateway backup state (`<backupDir>/state.json`): one row per vault
 * this gateway has ever backed up, plus a `sourceInstanceId` — the random
 * id every snapshot's `appMeta.sourceInstanceId` carries (FORMAT.md
 * manifest §, "random id minted per gateway install") so a restoring
 * client can tell which physical install wrote a given snapshot.
 *
 * Atomic writes (temp + rename), like `local-provider.ts`'s registry and
 * `crypto.ts`'s keyring — a crash mid-write must never leave a torn file
 * the next boot reads as truth.
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface BackupTargetState {
  targetId: string;
  /** The opaque random label the target was created with (never the vault name). */
  label: string;
  /** Fencing generation (PROTOCOL.md § Generation fencing) — starts at 1. */
  generation: number;
  lastBackupAt?: string;
  lastVerifiedAt?: string;
  lastSeq?: number;
  /**
   * Set once a `conflict_generation` response is seen (PROTOCOL.md: "never
   * retry with a bumped generation automatically"). While fenced, the
   * scheduler skips this vault; a manual `backup run` still attempts (and
   * will 409 again) so the operator sees the same loud signal on demand.
   */
  fenced?: boolean;
  lastError?: string;
}

/**
 * Recovery-kit confirmation gate (issue #351 wave 4 / #367): a generic
 * "the operator has confirmed they hold the recovery kit" flag, NOT
 * scoped to the backup card that first surfaces it — issue #367 will
 * reuse this exact field to gate the S3-storage enable flow, so it stays
 * a plain acknowledgement rather than anything backup-specific.
 */
export interface RecoveryKitState {
  /** Epoch SECONDS the operator last confirmed, or `null` if never. */
  confirmedAt: number | null;
}

export interface BackupState {
  targets: Record<string, BackupTargetState>;
  /** Random id minted once per gateway install (FORMAT.md `appMeta.sourceInstanceId`). */
  sourceInstanceId: string;
  recoveryKit: RecoveryKitState;
}

function emptyState(): BackupState {
  return {
    targets: {},
    sourceInstanceId: randomBytes(16).toString('hex'),
    recoveryKit: { confirmedAt: null },
  };
}

export function stateFile(backupDir: string): string {
  return path.join(backupDir, 'state.json');
}

export async function loadBackupState(backupDir: string): Promise<BackupState> {
  try {
    const raw = await fs.readFile(stateFile(backupDir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<BackupState>;
    return {
      targets: parsed.targets ?? {},
      sourceInstanceId: parsed.sourceInstanceId ?? randomBytes(16).toString('hex'),
      // Absent on a state.json written before this wave — defaults to
      // "never confirmed" rather than assuming a pre-existing install
      // already handled its recovery kit.
      recoveryKit: parsed.recoveryKit ?? { confirmedAt: null },
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return emptyState();
  }
}

export async function saveBackupState(backupDir: string, state: BackupState): Promise<void> {
  await fs.mkdir(backupDir, { recursive: true });
  const file = stateFile(backupDir);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
}

/** A random, opaque target label — PROTOCOL.md: "Clients MUST NOT send real vault names". */
export function opaqueLabel(): string {
  return randomBytes(8).toString('hex');
}
