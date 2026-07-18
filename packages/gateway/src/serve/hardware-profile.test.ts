import { expect, test } from 'vitest';
import { resolveGatewayHardwareProfile } from './hardware-profile.js';

test('slow storage selects one coherent constrained-host profile', () => {
  expect(
    resolveGatewayHardwareProfile(
      { cores: 8, totalMemoryBytes: 16 * 1024 ** 3, storageFsyncMs: 20 },
      {},
    ),
  ).toMatchObject({
    class: 'constrained',
    sqliteSynchronous: 'NORMAL',
    workerMaxConcurrent: 2,
    workerMaxOldGenerationMb: 128,
    workerPoolSize: 0,
    replicationConcurrency: 1,
    staticBrotliQuality: 5,
    vaultMountStrategy: 'eager',
    vaultSweepIntervalMs: 7_200_000,
    outboxIdleIntervalMs: 120_000,
  });
});

test('explicit profile and durability overrides win over detection', () => {
  expect(
    resolveGatewayHardwareProfile(
      { cores: 2, totalMemoryBytes: 1024 ** 3, storageFsyncMs: 30 },
      { CENTRAID_HARDWARE_PROFILE: 'standard', CENTRAID_SQLITE_SYNCHRONOUS: 'NORMAL' },
    ),
  ).toMatchObject({
    class: 'standard',
    sqliteSynchronous: 'NORMAL',
    workerPoolSize: 2,
    vaultMountStrategy: 'eager',
    vaultSweepIntervalMs: 3_600_000,
    outboxIdleIntervalMs: 60_000,
  });
});
