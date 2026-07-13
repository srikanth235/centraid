import { writeRecoveryKit, type Keyring, type RecoveryKitTarget } from '@centraid/backup';
import type { BackupState } from './backup-state.js';

function targets(state: BackupState, provider: string): RecoveryKitTarget[] {
  return Object.entries(state.targets).map(([vaultId, target]) => ({
    provider,
    targetId: target.targetId,
    vaultId,
    label: target.label,
  }));
}

export function recoveryKitDocument(opts: {
  keyring: Keyring;
  state: BackupState;
  provider: string;
  now: number;
}): Record<string, unknown> {
  return {
    version: 1,
    kind: 'centraid-recovery-kit',
    createdAt: new Date(opts.now).toISOString(),
    keyring: opts.keyring,
    targets: targets(opts.state, opts.provider),
  };
}

export async function writeBackupRecoveryKit(opts: {
  keyring: Keyring;
  state: BackupState;
  provider: string;
  destFile: string;
}): Promise<void> {
  await writeRecoveryKit({
    keyring: opts.keyring,
    targets: targets(opts.state, opts.provider),
    destFile: opts.destFile,
  });
}
