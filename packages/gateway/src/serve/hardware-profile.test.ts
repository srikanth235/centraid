import { expect, test } from 'vitest';
import {
  formatHardwareProfileDetail,
  hardwareClassForResourceMode,
  RESOURCE_KNOB_BOUNDS,
  resolveGatewayHardwareProfile,
  type ResourceKnobName,
  type ResourceKnobSource,
  toStructuredResourceProfile,
} from './hardware-profile.js';

/** All six knobs Linked to the preset — the no-override baseline. */
const ALL_PRESET_SOURCES: Record<ResourceKnobName, ResourceKnobSource> = {
  workerMaxConcurrent: { source: 'preset' },
  workerMaxOldGenerationMb: { source: 'preset' },
  workerPoolSize: { source: 'preset' },
  replicationConcurrency: { source: 'preset' },
  staticBrotliQuality: { source: 'preset' },
  staticGzipQuality: { source: 'preset' },
};

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

test('toStructuredResourceProfile projects a constrained conserve profile', () => {
  const profile = resolveGatewayHardwareProfile(
    { cores: 2, totalMemoryBytes: 2 * 1024 ** 3, storageFsyncMs: 20, resourceMode: 'conserve' },
    {},
  );
  expect(toStructuredResourceProfile(profile)).toEqual({
    class: 'constrained',
    mode: 'conserve',
    host: {
      cores: 2,
      totalMemoryBytes: 2 * 1024 ** 3,
      storageFsyncMs: 20,
      cgroupLimitedCpu: false,
      cgroupLimitedMemory: false,
      stealPercent: null,
    },
    budget: { cpuShare: 0.5, memoryCapMb: Math.round(((2 * 1024 ** 3) / 1024 ** 2) * 0.5) },
    resolved: {
      workerMaxConcurrent: 2,
      workerMaxOldGenerationMb: 128,
      workerPoolSize: 0,
      replicationConcurrency: 1,
      staticBrotliQuality: 5,
      staticGzipQuality: 6,
      sqliteSynchronous: 'NORMAL',
      vaultSweepIntervalMs: 7_200_000,
      outboxIdleIntervalMs: 120_000,
    },
    sources: ALL_PRESET_SOURCES,
    bounds: RESOURCE_KNOB_BOUNDS,
  });
});

test('toStructuredResourceProfile projects a standard performance profile', () => {
  const profile = resolveGatewayHardwareProfile(
    { cores: 8, totalMemoryBytes: 16 * 1024 ** 3, storageFsyncMs: 1, resourceMode: 'performance' },
    {},
  );
  expect(toStructuredResourceProfile(profile)).toEqual({
    class: 'standard',
    mode: 'performance',
    host: {
      cores: 8,
      totalMemoryBytes: 16 * 1024 ** 3,
      storageFsyncMs: 1,
      cgroupLimitedCpu: false,
      cgroupLimitedMemory: false,
      stealPercent: null,
    },
    budget: { cpuShare: 1, memoryCapMb: Math.round((16 * 1024 ** 3) / 1024 ** 2) },
    resolved: {
      workerMaxConcurrent: 12,
      workerMaxOldGenerationMb: 384,
      workerPoolSize: 4,
      replicationConcurrency: 4,
      staticBrotliQuality: 10,
      staticGzipQuality: 9,
      sqliteSynchronous: 'FULL',
      vaultSweepIntervalMs: 3_600_000,
      outboxIdleIntervalMs: 60_000,
    },
    sources: ALL_PRESET_SOURCES,
    bounds: RESOURCE_KNOB_BOUNDS,
  });
});

test('toStructuredResourceProfile carries a null host storageFsyncMs through', () => {
  const profile = resolveGatewayHardwareProfile({ cores: 8, totalMemoryBytes: 16 * 1024 ** 3 }, {});
  expect(toStructuredResourceProfile(profile).host.storageFsyncMs).toBeNull();
});

test('cgroup CPU quota sizes a big host down to its granted share', () => {
  // 16 raw cores, quota 2 → sized like a 2-core (constrained) host.
  const profile = resolveGatewayHardwareProfile(
    { cores: 16, totalMemoryBytes: 64 * 1024 ** 3, storageFsyncMs: 1, cgroupCpuLimit: 2 },
    {},
  );
  expect(profile).toMatchObject({
    class: 'constrained',
    cgroupLimitedCpu: true,
    cgroupLimitedMemory: false,
    workerMaxConcurrent: 2,
    workerPoolSize: 0,
    replicationConcurrency: 1,
    // Durability stays FULL — cgroup detection never implies NORMAL.
    sqliteSynchronous: 'FULL',
  });
  // Raw host facts are preserved; the flag carries the "granted share" story.
  expect(profile.cores).toBe(16);
});

test('a cgroup quota at or above the raw cores does not constrain', () => {
  const profile = resolveGatewayHardwareProfile(
    { cores: 8, totalMemoryBytes: 16 * 1024 ** 3, storageFsyncMs: 1, cgroupCpuLimit: 8 },
    {},
  );
  expect(profile).toMatchObject({ class: 'standard', cgroupLimitedCpu: false });
});

test('a fractional cgroup quota rounds up to whole granted cores', () => {
  // quota 6.5 on 8 cores → ceil 7 effective cores, still standard.
  const profile = resolveGatewayHardwareProfile(
    { cores: 8, totalMemoryBytes: 16 * 1024 ** 3, storageFsyncMs: 1, cgroupCpuLimit: 6.5 },
    {},
  );
  expect(profile).toMatchObject({ class: 'standard', cgroupLimitedCpu: true });
});

test('cgroup memory limit constrains a big host and shrinks the budget cap', () => {
  const profile = resolveGatewayHardwareProfile(
    {
      cores: 16,
      totalMemoryBytes: 64 * 1024 ** 3,
      storageFsyncMs: 1,
      cgroupMemoryLimitBytes: 2 * 1024 ** 3,
    },
    {},
  );
  expect(profile).toMatchObject({
    class: 'constrained',
    cgroupLimitedMemory: true,
    cgroupLimitedCpu: false,
  });
  // memoryCapMb is a share of the EFFECTIVE (granted) 2 GiB, not the raw 64 GiB.
  expect(profile.budget.memoryCapMb).toBe(Math.round(((2 * 1024 ** 3) / 1024 ** 2) * 0.5));
});

test('high CPU steal biases an otherwise-large host to constrained', () => {
  const profile = resolveGatewayHardwareProfile(
    { cores: 16, totalMemoryBytes: 64 * 1024 ** 3, storageFsyncMs: 1, stealPercent: 15 },
    {},
  );
  expect(profile).toMatchObject({
    class: 'constrained',
    stealPercent: 15,
    workerMaxConcurrent: 2,
    // Steal is a sizing signal, never a durability trade.
    sqliteSynchronous: 'FULL',
  });
});

test('steal below the threshold is a no-op on class', () => {
  const profile = resolveGatewayHardwareProfile(
    { cores: 16, totalMemoryBytes: 64 * 1024 ** 3, storageFsyncMs: 1, stealPercent: 9 },
    {},
  );
  expect(profile).toMatchObject({ class: 'standard', stealPercent: 9, workerMaxConcurrent: 8 });
});

test('absent cgroup/steal inputs resolve to the plain-host baseline', () => {
  const withNulls = resolveGatewayHardwareProfile(
    {
      cores: 8,
      totalMemoryBytes: 16 * 1024 ** 3,
      storageFsyncMs: 1,
      cgroupCpuLimit: null,
      cgroupMemoryLimitBytes: null,
      stealPercent: null,
    },
    {},
  );
  const baseline = resolveGatewayHardwareProfile(
    { cores: 8, totalMemoryBytes: 16 * 1024 ** 3, storageFsyncMs: 1 },
    {},
  );
  expect(withNulls).toEqual(baseline);
  expect(withNulls).toMatchObject({
    class: 'standard',
    cgroupLimitedCpu: false,
    cgroupLimitedMemory: false,
    stealPercent: null,
  });
});

test('env overrides still win with clamps under a cgroup-constrained host', () => {
  const profile = resolveGatewayHardwareProfile(
    { cores: 16, totalMemoryBytes: 64 * 1024 ** 3, storageFsyncMs: 1, cgroupCpuLimit: 2 },
    { CENTRAID_WORKER_MAX_CONCURRENT: '6' },
  );
  // Operator override wins over the cgroup-derived conserve budget.
  expect(profile.workerMaxConcurrent).toBe(6);
});

test('a high-steal host in auto mode never trades down durability', () => {
  const profile = resolveGatewayHardwareProfile(
    { cores: 16, totalMemoryBytes: 64 * 1024 ** 3, storageFsyncMs: 1, stealPercent: 40 },
    {},
  );
  expect(profile.sqliteSynchronous).toBe('FULL');
});

test('budget presets frame conserve/balanced/performance as a share of the granted host', () => {
  const conserve = resolveGatewayHardwareProfile(
    { cores: 2, totalMemoryBytes: 4 * 1024 ** 3, resourceMode: 'conserve' },
    {},
  );
  const balanced = resolveGatewayHardwareProfile(
    { cores: 8, totalMemoryBytes: 16 * 1024 ** 3, resourceMode: 'balanced' },
    {},
  );
  const performance = resolveGatewayHardwareProfile(
    { cores: 8, totalMemoryBytes: 16 * 1024 ** 3, resourceMode: 'performance' },
    {},
  );
  expect(conserve.budget.cpuShare).toBe(0.5);
  expect(balanced.budget.cpuShare).toBe(0.75);
  expect(performance.budget.cpuShare).toBe(1);
  expect(performance.budget.memoryCapMb).toBeGreaterThan(balanced.budget.memoryCapMb);
});

test('hardwareClassForResourceMode maps modes without re-detection', () => {
  expect(hardwareClassForResourceMode('auto', 'constrained')).toBe('constrained');
  expect(hardwareClassForResourceMode('auto', 'standard')).toBe('standard');
  expect(hardwareClassForResourceMode('conserve', 'standard')).toBe('constrained');
  expect(hardwareClassForResourceMode('balanced', 'constrained')).toBe('standard');
  expect(hardwareClassForResourceMode('performance', 'constrained')).toBe('standard');
});

// --- #528 Phase F: durable per-knob UI overrides through the ONE resolver ---

const STANDARD_HOST = { cores: 8, totalMemoryBytes: 16 * 1024 ** 3, storageFsyncMs: 1 };

test('a prefs override wins over the preset baseline and is attributed to prefs', () => {
  const profile = resolveGatewayHardwareProfile(
    { ...STANDARD_HOST, prefsOverrides: { workerMaxConcurrent: 5 } },
    {},
  );
  // Balanced preset would be 8; the durable override lands 5.
  expect(profile.workerMaxConcurrent).toBe(5);
  expect(profile.sources.workerMaxConcurrent).toEqual({ source: 'prefs' });
  // Untouched knobs stay Linked to the preset.
  expect(profile.sources.replicationConcurrency).toEqual({ source: 'preset' });
});

test('env still wins over a prefs override for the same knob, with the env var named', () => {
  const profile = resolveGatewayHardwareProfile(
    { ...STANDARD_HOST, prefsOverrides: { workerMaxConcurrent: 5 } },
    { CENTRAID_WORKER_MAX_CONCURRENT: '9' },
  );
  expect(profile.workerMaxConcurrent).toBe(9);
  expect(profile.sources.workerMaxConcurrent).toEqual({
    source: 'env',
    envVar: 'CENTRAID_WORKER_MAX_CONCURRENT',
  });
});

test('a prefs override clamps through the same bounds as env', () => {
  const profile = resolveGatewayHardwareProfile(
    {
      ...STANDARD_HOST,
      prefsOverrides: { workerMaxConcurrent: 999, workerMaxOldGenerationMb: 4 },
    },
    {},
  );
  // Above-max clamps to the ceiling; below-min is rejected → preset carries.
  expect(profile.workerMaxConcurrent).toBe(RESOURCE_KNOB_BOUNDS.workerMaxConcurrent.max);
  expect(profile.sources.workerMaxConcurrent).toEqual({ source: 'prefs' });
  expect(profile.workerMaxOldGenerationMb).toBe(256); // balanced preset
  expect(profile.sources.workerMaxOldGenerationMb).toEqual({ source: 'preset' });
});

test('a prefs override of a knob does not disturb the compression sources', () => {
  const profile = resolveGatewayHardwareProfile(
    { ...STANDARD_HOST, prefsOverrides: { replicationConcurrency: 2 } },
    { CENTRAID_STATIC_BROTLI_QUALITY: '3' },
  );
  expect(profile.sources.replicationConcurrency).toEqual({ source: 'prefs' });
  expect(profile.sources.staticBrotliQuality).toEqual({
    source: 'env',
    envVar: 'CENTRAID_STATIC_BROTLI_QUALITY',
  });
  // The static quality knobs never carry a prefs source (no pref key).
  expect(profile.sources.staticGzipQuality).toEqual({ source: 'preset' });
});

test('no prefsOverrides yields output identical to omitting the field', () => {
  const withEmpty = resolveGatewayHardwareProfile({ ...STANDARD_HOST, prefsOverrides: {} }, {});
  const without = resolveGatewayHardwareProfile({ ...STANDARD_HOST }, {});
  expect(withEmpty).toEqual(without);
  expect(withEmpty.sources).toEqual(ALL_PRESET_SOURCES);
});

test('the structured profile publishes the bounds table for the client', () => {
  const structured = toStructuredResourceProfile(
    resolveGatewayHardwareProfile({ ...STANDARD_HOST }, {}),
  );
  expect(structured.bounds).toEqual(RESOURCE_KNOB_BOUNDS);
  expect(structured.bounds.workerPoolSize).toEqual({ min: 0, max: 8 });
});
