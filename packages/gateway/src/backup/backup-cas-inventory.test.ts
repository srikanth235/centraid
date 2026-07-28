// CAS inventory collector unit tests (issue #545 B7) — mocked storage connections.

import { bootstrapVault, openVaultDb, updateBlobStoreSettings } from '@centraid/vault';
import { afterEach, describe, expect, test } from 'vitest';

import { collectCasInventory } from './backup-cas-inventory.js';

const opened: ReturnType<typeof openVaultDb>[] = [];
describe('backup-cas-inventory', () => {
  afterEach(() => {
    while (opened.length > 0) opened.pop()?.close();
  });

  function db() {
    const value = openVaultDb();
    bootstrapVault(value, { vaultId: 'vault-a', ownerName: 'Priya' });
    opened.push(value);
    return value;
  }

  test('collectCasInventory reports not configured when the vault is not on S3', async () => {
    const result = await collectCasInventory({ db: db(), verifyBucket: false });
    expect(result).toStrictEqual({ configured: false });
  });

  test('collectCasInventory errors when S3 is configured without a connection store', async () => {
    const vault = db();
    updateBlobStoreSettings(vault, {
      blob_store: {
        kind: 's3',
        endpoint: 'https://s3.example',
        bucket: 'b',
        region: 'us-east-1',
        connectionId: 'conn-1',
      },
    });
    const result = await collectCasInventory({
      db: vault,
      verifyBucket: true,
    });
    expect(result.configured).toBe(true);
    expect(result.error).toMatch(/storage connection/iu);
  });

  test('collectCasInventory reports not configured for derived when derivedPrefix is absent', async () => {
    const vault = db();
    updateBlobStoreSettings(vault, {
      blob_store: {
        kind: 's3',
        endpoint: 'https://s3.example',
        bucket: 'b',
        connectionId: 'conn-1',
      },
    });
    const result = await collectCasInventory({
      db: vault,
      verifyBucket: false,
      store: 'derived',
      storageConnections: {
        get: async () => undefined,
        resolveProviderApiKey: async () => 'k',
      } as never,
    });
    expect(result).toStrictEqual({ configured: false });
  });
});
