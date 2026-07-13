import { describe, expect, it, vi } from 'vitest';
import type { BackupProvider } from '@centraid/backup';
import type { StorageConnectionStore } from './storage-connections.js';
import { resolveBackupBackend } from './backup-backend.js';

describe('resolveBackupBackend', () => {
  it('keeps an explicit daemon provider authoritative', async () => {
    const provider = {} as BackupProvider;
    const backend = await resolveBackupBackend({
      config: {
        enabled: true,
        provider: { kind: 'remote', endpoint: 'https://static.example', apiKey: 'secret' },
      },
      provider,
    });
    expect(backend).toMatchObject({
      provider,
      providerRef: 'static:https://static.example',
      dynamic: false,
    });
  });

  it('activates the provider connection marked for backup', async () => {
    const resolveProviderApiKey = vi.fn().mockResolvedValue('sk-live');
    const storageConnections = {
      list: async () => [
        {
          id: 'provider-1',
          kind: 'provider',
          name: 'Clawgnition',
          uses: ['backup', 'cas'],
          baseUrl: 'https://storage.example',
        },
      ],
      resolveProviderApiKey,
    } as unknown as StorageConnectionStore;
    const backend = await resolveBackupBackend({ storageConnections });
    expect(backend).toMatchObject({
      providerRef: 'connection:provider-1:https://storage.example',
      label: 'https://storage.example',
      dynamic: true,
    });
    expect(resolveProviderApiKey).toHaveBeenCalledWith('provider-1');
  });

  it('does not mistake a direct S3 CAS connection for a backup provider', async () => {
    const storageConnections = {
      list: async () => [{ id: 's3-1', kind: 'byo-s3', uses: ['cas'] }],
    } as unknown as StorageConnectionStore;
    expect(await resolveBackupBackend({ storageConnections })).toBeUndefined();
  });
});
