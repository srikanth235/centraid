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

  it('activates the single home connection (#436 §7)', async () => {
    const resolveProviderApiKey = vi.fn().mockResolvedValue('sk-live');
    const storageConnections = {
      list: async () => [
        {
          id: 'provider-1',
          kind: 'provider',
          name: 'Clawgnition',
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

  it('returns undefined when no connection is configured', async () => {
    const storageConnections = {
      list: async () => [],
    } as unknown as StorageConnectionStore;
    expect(await resolveBackupBackend({ storageConnections })).toBeUndefined();
  });
});
