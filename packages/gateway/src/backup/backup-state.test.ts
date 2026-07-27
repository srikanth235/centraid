import { tempDir } from '@centraid/test-kit/temp-dir';
import { endpointIdForSecret } from '@centraid/tunnel';
import { KeyStore } from '@centraid/vault';
import { createHmac } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { GatewayDatabase } from '../serve/gateway-db.js';
import { deriveBackupSourceInstanceId } from './backup-state.js';

describe('backup-state', () => {
  test('backup source identity survives restart and a lost gateway.db without becoming public', async () => {
    const dataDir = await tempDir('backup-source-id-');
    const keys = new KeyStore(path.join(dataDir, 'keys'));
    const endpointSecret = keys.loadOrCreate('endpoint-key.bin');
    const first = deriveBackupSourceInstanceId(endpointSecret);

    const database = GatewayDatabase.open(dataDir);
    database.close();
    await fs.rm(path.join(dataDir, 'gateway.db'));

    const afterDatabaseLoss = deriveBackupSourceInstanceId(
      new KeyStore(path.join(dataDir, 'keys')).loadOrCreate('endpoint-key.bin'),
    );
    expect(afterDatabaseLoss).toBe(first);

    const publicEndpointId = endpointIdForSecret(endpointSecret);
    const publicGuess = createHmac('sha256', Buffer.from(publicEndpointId, 'utf8'))
      .update('backup-source', 'utf8')
      .digest('hex');
    expect(publicGuess).not.toBe(first);
  });
});
