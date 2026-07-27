import { tempDir } from '@centraid/test-kit/temp-dir';
import { describe, expect, test } from 'vitest';
import { GatewayDatabase } from '../serve/gateway-db.js';
import { RecoveryKitStateStore } from './recovery-kit-state.js';

describe('recovery-kit-state', () => {
  test('ordinary kit staleness never reopens the founding gate', async () => {
    const database = GatewayDatabase.open(await tempDir('recovery-kit-state-'));
    try {
      const store = new RecoveryKitStateStore(database);
      await store.begin('ordinary-fingerprint');

      expect(store.ceremonyIncomplete()).toBe(false);
      await expect(store.status()).resolves.toStrictEqual({
        confirmedAt: null,
        kitFingerprint: 'ordinary-fingerprint',
      });
    } finally {
      database.close();
    }
  });

  test('only an unverified founding kit blocks first run and exact verification clears it', async () => {
    const database = GatewayDatabase.open(await tempDir('recovery-kit-founding-'));
    try {
      const store = new RecoveryKitStateStore(database, () => 1_752_235_200_000);
      await store.begin('founding-fingerprint', { founding: true });

      expect(store.ceremonyIncomplete()).toBe(true);
      await expect(store.verify('wrong-fingerprint')).resolves.toBeUndefined();
      expect(store.ceremonyIncomplete()).toBe(true);
      await expect(store.verify('founding-fingerprint')).resolves.toStrictEqual({
        confirmedAt: 1_752_235_200,
        kitFingerprint: 'founding-fingerprint',
      });
      expect(store.ceremonyIncomplete()).toBe(false);
    } finally {
      database.close();
    }
  });
});
