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
    // Detection tunes concurrency, but durability only relaxes on an
    // explicit operator choice.
    sqliteSynchronous: 'FULL',
    workerMaxConcurrent: 2,
    workerMaxOldGenerationMb: 128,
    workerPoolSize: 0,
    replicationConcurrency: 1,
    staticBrotliQuality: 5,
    staticGzipQuality: 6,
    vaultMountStrategy: 'eager',
    vaultSweepIntervalMs: 7_200_000,
    outboxIdleIntervalMs: 120_000,
  });
});

test('only an explicitly selected constrained profile opts into NORMAL', () => {
  expect(
    resolveGatewayHardwareProfile(
      { cores: 8, totalMemoryBytes: 16 * 1024 ** 3, storageFsyncMs: 1 },
      { CENTRAID_HARDWARE_PROFILE: 'constrained' },
    ),
  ).toMatchObject({ class: 'constrained', sqliteSynchronous: 'NORMAL' });
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

test('explicit tuning overrides are reflected in the resolved profile', () => {
  expect(
    resolveGatewayHardwareProfile(
      { cores: 8, totalMemoryBytes: 16 * 1024 ** 3, storageFsyncMs: 1 },
      {
        CENTRAID_WORKER_MAX_CONCURRENT: '3',
        CENTRAID_WORKER_MAX_OLD_GENERATION_MB: '192',
        CENTRAID_WORKER_POOL_SIZE: '1',
        CENTRAID_REPLICATION_CONCURRENCY: '2',
        CENTRAID_STATIC_BROTLI_QUALITY: '7',
        CENTRAID_STATIC_GZIP_QUALITY: '8',
      },
    ),
  ).toMatchObject({
    workerMaxConcurrent: 3,
    workerMaxOldGenerationMb: 192,
    workerPoolSize: 1,
    replicationConcurrency: 2,
    staticBrotliQuality: 7,
    staticGzipQuality: 8,
  });
});
