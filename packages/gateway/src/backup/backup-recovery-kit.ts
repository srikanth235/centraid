import {
  writeRecoveryKit,
  type Keyring,
  type RecoveryKitDocument,
  type RecoveryKitTarget,
} from '@centraid/backup';
import type { KeyStore } from '@centraid/vault';
import type { BackupState } from './backup-state.js';

function targets(state: BackupState, provider: string, keyStore: KeyStore): RecoveryKitTarget[] {
  return Object.entries(state.targets).map(([vaultId, target]) => ({
    provider,
    targetId: target.targetId,
    vaultId,
    label: target.label,
    sealKey: requiredSealKey(keyStore, vaultId).toString('base64'),
  }));
}

function requiredSealKey(keyStore: KeyStore, vaultId: string): Buffer {
  const key = keyStore.export(`${vaultId}.sealkey`);
  if (!key) throw new Error(`recovery kit: vault "${vaultId}" has no sealing key in custody`);
  return key;
}

export function recoveryKitDocument(opts: {
  keyring: Keyring;
  state: BackupState;
  provider: string;
  now: number;
  keyStore: KeyStore;
}): RecoveryKitDocument {
  return {
    version: 1,
    kind: 'centraid-recovery-kit',
    createdAt: new Date(opts.now).toISOString(),
    keyring: opts.keyring,
    targets: targets(opts.state, opts.provider, opts.keyStore),
  };
}

export async function writeBackupRecoveryKit(opts: {
  keyring: Keyring;
  state: BackupState;
  provider: string;
  destFile: string;
  keyStore: KeyStore;
}): Promise<void> {
  await writeRecoveryKit({
    keyring: opts.keyring,
    targets: targets(opts.state, opts.provider, opts.keyStore),
    destFile: opts.destFile,
  });
}
