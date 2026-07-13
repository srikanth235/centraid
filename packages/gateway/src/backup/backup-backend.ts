import { openRemoteBackupProvider, type BackupProvider } from '@centraid/backup';
import type { BackupConfig, BackupProviderConfig } from './backup-config.js';
import type { StorageConnectionStore } from './storage-connections.js';

export interface ResolvedBackupBackend {
  provider: BackupProvider;
  providerRef: string;
  label: string;
  dynamic: boolean;
}

export function backupProviderLabel(config: BackupProviderConfig): string {
  return config.kind === 'remote' ? config.endpoint : `local:${config.dir}`;
}

export async function resolveBackupBackend(opts: {
  config?: BackupConfig;
  provider?: BackupProvider;
  storageConnections?: StorageConnectionStore;
}): Promise<ResolvedBackupBackend | undefined> {
  if (opts.config && opts.provider) {
    const label = backupProviderLabel(opts.config.provider);
    return { provider: opts.provider, providerRef: `static:${label}`, label, dynamic: false };
  }
  if (!opts.storageConnections) return undefined;
  const matches = (await opts.storageConnections.list()).filter(
    (connection) => connection.kind === 'provider' && connection.uses.includes('backup'),
  );
  if (matches.length === 0) return undefined;
  if (matches.length > 1) throw new Error('backup: multiple active backup destinations found');
  const connection = matches[0]!;
  const apiKey = await opts.storageConnections.resolveProviderApiKey(connection.id);
  return {
    provider: openRemoteBackupProvider({ baseUrl: connection.baseUrl!, apiKey }),
    providerRef: `connection:${connection.id}:${connection.baseUrl!}`,
    label: connection.baseUrl!,
    dynamic: true,
  };
}
