import { existsSync, mkdirSync, promises as fs, writeFileSync } from 'node:fs';
import path from 'node:path';

import { forEachSequentially } from '@centraid/test-kit/sequential';
import { tempDir } from '@centraid/test-kit/temp-dir';
import { KeyStore, uuidv7 } from '@centraid/vault';
import { afterEach, describe, expect, test } from 'vitest';

import { daemonLayoutFor } from '../cli/paths.js';
import { recoverPendingFoundingVaults } from './founding-recovery.js';
import { GatewayDatabase } from './gateway-db.js';
import { PairingTicketStore } from './pairing-store.js';
import { openVaultRegistry } from './vault-registry.js';

const cleanups: Array<() => Promise<void> | void> = [];
describe('founding-recovery', () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) => cleanup());
  });

  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  test('boot removes a process-crashed founding vault before registry scan and preserves retry', async () => {
    const dataDir = await tempDir('founding-recovery-');
    cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
    const layout = daemonLayoutFor(dataDir);
    const keys = new KeyStore(layout.keysDir);
    const database = GatewayDatabase.open(dataDir);
    const tickets = PairingTicketStore.open(database);
    const minted = tickets.mintFounding()!;
    const reservation = tickets.reserveFounding(minted.ticketId, minted.secret);
    expect(reservation).toBeDefined();

    const vaultId = uuidv7();
    expect(tickets.stageReservedFoundingVaults(reservation!, [vaultId])).toBe(true);
    const registry = openVaultRegistry({
      rootDir: layout.vaultDir,
      cacheRootDir: layout.cacheDir,
      keyStore: keys,
      logger,
    });
    registry.create('Interrupted founding', vaultId);
    registry.stop();
    expect(keys.export(`${vaultId}.sealkey`)).toBeDefined();
    database.run(
      `INSERT INTO backup_targets (target_id, vault_id, config_json, updated_at)
     VALUES (?, ?, ?, ?)`,
      'interrupted-target',
      vaultId,
      '{}',
      new Date().toISOString(),
    );
    const scratch = path.join(layout.vaultDir, '.recover-work-interrupted');
    mkdirSync(scratch, { recursive: true });
    writeFileSync(path.join(scratch, 'partial'), 'partial');
    database.close();

    const restarted = GatewayDatabase.open(dataDir);
    cleanups.push(() => restarted.close());
    const restartedTickets = PairingTicketStore.open(restarted);
    expect(
      recoverPendingFoundingVaults({
        gatewayDatabase: restarted,
        vaultRoot: layout.vaultDir,
        cacheRoot: layout.cacheDir,
        keys,
        logger,
      }),
    ).toStrictEqual([vaultId]);
    expect(existsSync(path.join(layout.vaultDir, vaultId))).toBe(false);
    expect(existsSync(scratch)).toBe(false);
    expect(keys.export(`${vaultId}.sealkey`)).toBeNull();
    expect(
      restarted.db.prepare('SELECT 1 FROM backup_targets WHERE vault_id = ?').get(vaultId),
    ).toBeUndefined();
    expect(restartedTickets.pendingFoundingVaults()).toStrictEqual([]);
    expect(restartedTickets.hasOpenFoundingWindow()).toBe(true);

    const recoveredRegistry = openVaultRegistry({
      rootDir: layout.vaultDir,
      cacheRootDir: layout.cacheDir,
      keyStore: keys,
      logger,
    });
    cleanups.push(() => recoveredRegistry.stop());
    expect(recoveredRegistry.isFresh()).toBe(true);
  });
});
