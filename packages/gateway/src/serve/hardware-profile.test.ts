import { expect, test } from 'vitest';
import {
  formatHardwareProfileDetail,
  hardwareClassForResourceMode,
  resolveGatewayHardwareProfile,
} from './hardware-profile.js';

test('slow storage selects one coherent constrained-host profile', () => {
  expect(
    resolveGatewayHardwareProfile(
      { cores: 8, totalMemoryBytes: 16 * 1024 ** 3, storageFsyncMs: 20 },
      {},
    ),
  ).toMatchObject({
    class: 'constrained',
    resourceMode: 'auto',
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

test('Conserve mode pins constrained limits and NORMAL durability', () => {
  const profile = resolveGatewayHardwareProfile(
    {
      cores: 16,
      totalMemoryBytes: 32 * 1024 ** 3,
      storageFsyncMs: 1,
      resourceMode: 'conserve',
    },
    {},
  );
  expect(profile).toMatchObject({
    class: 'constrained',
    resourceMode: 'conserve',
    sqliteSynchronous: 'NORMAL',
    workerMaxConcurrent: 2,
    workerPoolSize: 0,
    replicationConcurrency: 1,
  });
  expect(formatHardwareProfileDetail(profile)).toContain('mode=Conserve');
  expect(formatHardwareProfileDetail(profile)).toContain('class=constrained');
});

test('Balanced mode pins standard throughput on a small host', () => {
  expect(
    resolveGatewayHardwareProfile(
      {
        cores: 2,
        totalMemoryBytes: 2 * 1024 ** 3,
        storageFsyncMs: 30,
        resourceMode: 'balanced',
      },
      {},
    ),
  ).toMatchObject({
    class: 'standard',
    resourceMode: 'balanced',
    workerMaxConcurrent: 8,
    workerPoolSize: 2,
    replicationConcurrency: 3,
    sqliteSynchronous: 'FULL',
  });
});

test('Performance mode raises standard-class worker and replication ceilings', () => {
  const performance = resolveGatewayHardwareProfile(
    {
      cores: 8,
      totalMemoryBytes: 16 * 1024 ** 3,
      storageFsyncMs: 1,
      resourceMode: 'performance',
    },
    {},
  );
  const balanced = resolveGatewayHardwareProfile(
    {
      cores: 8,
      totalMemoryBytes: 16 * 1024 ** 3,
      storageFsyncMs: 1,
      resourceMode: 'balanced',
    },
    {},
  );
  expect(performance.class).toBe('standard');
  expect(performance.workerMaxConcurrent).toBeGreaterThan(balanced.workerMaxConcurrent);
  expect(performance.workerPoolSize).toBeGreaterThan(balanced.workerPoolSize);
  expect(performance.replicationConcurrency).toBeGreaterThan(balanced.replicationConcurrency);
});

test('CENTRAID_HARDWARE_PROFILE still wins over Resource mode for class', () => {
  expect(
    resolveGatewayHardwareProfile(
      { cores: 16, totalMemoryBytes: 32 * 1024 ** 3, resourceMode: 'conserve' },
      { CENTRAID_HARDWARE_PROFILE: 'standard' },
    ),
  ).toMatchObject({ class: 'standard', resourceMode: 'conserve' });
});

test('hardwareClassForResourceMode maps modes without re-detection', () => {
  expect(hardwareClassForResourceMode('auto', 'constrained')).toBe('constrained');
  expect(hardwareClassForResourceMode('auto', 'standard')).toBe('standard');
  expect(hardwareClassForResourceMode('conserve', 'standard')).toBe('constrained');
  expect(hardwareClassForResourceMode('balanced', 'constrained')).toBe('standard');
  expect(hardwareClassForResourceMode('performance', 'constrained')).toBe('standard');
});
