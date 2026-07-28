import { tempDir } from '@centraid/test-kit/temp-dir';
import { expect, test } from 'vitest';
import { GatewayDatabase } from '../serve/gateway-db.js';
import { RecoveryKitStateStore } from './recovery-kit-state.js';

test('beginning a kit records its fingerprint and leaves it unconfirmed', async () => {
  const database = GatewayDatabase.open(await tempDir('recovery-kit-state-'));
  try {
    const store = new RecoveryKitStateStore(database);
    await store.begin('ordinary-fingerprint');

    expect(await store.status()).toEqual({
      confirmedAt: null,
      kitFingerprint: 'ordinary-fingerprint',
    });
  } finally {
    database.close();
  }
});

test('only the exact fingerprint verifies, and a new kit resets confirmation', async () => {
  const database = GatewayDatabase.open(await tempDir('recovery-kit-verify-'));
  try {
    const store = new RecoveryKitStateStore(database, () => 1_752_235_200_000);
    await store.begin('first-fingerprint');

    expect(await store.verify('wrong-fingerprint')).toBeUndefined();
    expect(await store.status()).toMatchObject({ confirmedAt: null });
    expect(await store.verify('first-fingerprint')).toEqual({
      confirmedAt: 1_752_235_200,
      kitFingerprint: 'first-fingerprint',
    });
    expect(await store.status()).toEqual({
      confirmedAt: 1_752_235_200,
      kitFingerprint: 'first-fingerprint',
    });

    // Exporting a NEW kit supersedes the confirmed one: the operator has to
    // retain and verify the kit they now hold, not the one they replaced.
    await store.begin('second-fingerprint');
    expect(await store.status()).toEqual({
      confirmedAt: null,
      kitFingerprint: 'second-fingerprint',
    });
  } finally {
    database.close();
  }
});
