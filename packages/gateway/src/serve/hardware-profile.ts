import { availableParallelism, totalmem } from 'node:os';
import { parseResourceMode, resourceModeLabel, type ResourceMode } from './resource-mode.js';

export type HardwareClass = 'constrained' | 'standard';
export type { ResourceMode };

export interface GatewayHardwareProfile {
  class: HardwareClass;
  /** Owner/operator Resource mode that selected this profile. */
  resourceMode: ResourceMode;
  cores: number;
  totalMemoryBytes: number;
  storageFsyncMs: number | null;
  sqliteSynchronous: 'FULL' | 'NORMAL';
  workerMaxConcurrent: number;
  workerMaxOldGenerationMb: number;
  workerPoolSize: number;
  replicationConcurrency: number;
  staticBrotliQuality: number;
  staticGzipQuality: number;
  /** Lazy mount remains gated by A5's scheduler index; correctness selects eager. */
  vaultMountStrategy: 'eager';
  vaultSweepIntervalMs: number;
  outboxIdleIntervalMs: number;
}

function integerOverride(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.min(parsed, maximum) : fallback;
}

/**
 * Map Resource mode onto a hardware class when the operator has not pinned
 * `CENTRAID_HARDWARE_PROFILE`. Auto keeps detection; Conserve pins
 * constrained; Balanced/Performance pin standard (Performance raises
 * throughput knobs further below).
 */
export function hardwareClassForResourceMode(
  mode: ResourceMode,
  detected: HardwareClass,
): HardwareClass {
  switch (mode) {
    case 'auto':
      return detected;
    case 'conserve':
      return 'constrained';
    case 'balanced':
    case 'performance':
      return 'standard';
  }
}

/**
 * Machine-readable projection of the resolved profile for the health
 * metrics surface (#528 Phase A). Deliberately separate from
 * `formatHardwareProfileDetail`'s human string: a self-hoster's own
 * monitoring reads these numbers without parsing prose, and the client
 * renders the same values in Diagnostics. Pure + unit-testable — the
 * only source of the shape `GET /_gateway/health` publishes.
 */
export interface StructuredResourceProfile {
  class: HardwareClass;
  mode: ResourceMode;
  host: { cores: number; totalMemoryBytes: number; storageFsyncMs: number | null };
  resolved: {
    workerMaxConcurrent: number;
    workerMaxOldGenerationMb: number;
    workerPoolSize: number;
    replicationConcurrency: number;
    staticBrotliQuality: number;
    staticGzipQuality: number;
    sqliteSynchronous: 'FULL' | 'NORMAL';
    vaultSweepIntervalMs: number;
    outboxIdleIntervalMs: number;
  };
}

export function toStructuredResourceProfile(
  profile: GatewayHardwareProfile,
): StructuredResourceProfile {
  return {
    class: profile.class,
    mode: profile.resourceMode,
    host: {
      cores: profile.cores,
      totalMemoryBytes: profile.totalMemoryBytes,
      storageFsyncMs: profile.storageFsyncMs,
    },
    resolved: {
      workerMaxConcurrent: profile.workerMaxConcurrent,
      workerMaxOldGenerationMb: profile.workerMaxOldGenerationMb,
      workerPoolSize: profile.workerPoolSize,
      replicationConcurrency: profile.replicationConcurrency,
      staticBrotliQuality: profile.staticBrotliQuality,
      staticGzipQuality: profile.staticGzipQuality,
      sqliteSynchronous: profile.sqliteSynchronous,
      vaultSweepIntervalMs: profile.vaultSweepIntervalMs,
      outboxIdleIntervalMs: profile.outboxIdleIntervalMs,
    },
  };
}

export function formatHardwareProfileDetail(profile: GatewayHardwareProfile): string {
  return (
    `mode=${resourceModeLabel(profile.resourceMode)} (${profile.resourceMode}); ` +
    `class=${profile.class}; sqlite=${profile.sqliteSynchronous}; ` +
    `workers=${profile.workerMaxConcurrent}x${profile.workerMaxOldGenerationMb}MB; ` +
    `pool=${profile.workerPoolSize}; replication=${profile.replicationConcurrency}; ` +
    `compression=br${profile.staticBrotliQuality}/gz${profile.staticGzipQuality}; ` +
    `mount=${profile.vaultMountStrategy}; sweep=${profile.vaultSweepIntervalMs}ms`
  );
}

export function resolveGatewayHardwareProfile(
  input: {
    cores?: number;
    totalMemoryBytes?: number;
    storageFsyncMs?: number;
    /** Durable/owner Resource mode (prefs or daemon config). */
    resourceMode?: ResourceMode;
  } = {},
  env: NodeJS.ProcessEnv = process.env,
): GatewayHardwareProfile {
  const cores = input.cores ?? availableParallelism();
  const totalMemoryBytes = input.totalMemoryBytes ?? totalmem();
  const storageFsyncMs = input.storageFsyncMs ?? null;
  const detected: HardwareClass =
    cores <= 4 || totalMemoryBytes <= 4 * 1024 ** 3 || (storageFsyncMs ?? 0) >= 8
      ? 'constrained'
      : 'standard';

  const resourceMode: ResourceMode =
    input.resourceMode ?? parseResourceMode(env.CENTRAID_RESOURCE_MODE) ?? 'auto';

  const requested = env.CENTRAID_HARDWARE_PROFILE;
  // Explicit env class still wins (operator override). Otherwise Resource
  // mode selects; Auto falls through to detection.
  const hardwareClass: HardwareClass =
    requested === 'constrained' || requested === 'standard'
      ? requested
      : hardwareClassForResourceMode(resourceMode, detected);

  // NORMAL durability only on an explicit constrained choice — either the
  // classic env pin or owner Conserve mode — never on mere auto-detection
  // of a small host (matches #456: only intentional low-end opts in).
  const syncOverride = env.CENTRAID_SQLITE_SYNCHRONOUS?.toUpperCase();
  const explicitConstrained =
    requested === 'constrained' || (requested === undefined && resourceMode === 'conserve');
  const sqliteSynchronous =
    syncOverride === 'FULL' || syncOverride === 'NORMAL'
      ? syncOverride
      : explicitConstrained
        ? 'NORMAL'
        : 'FULL';

  const constrained = hardwareClass === 'constrained';
  const performance = !constrained && resourceMode === 'performance';

  return {
    class: hardwareClass,
    resourceMode,
    cores,
    totalMemoryBytes,
    storageFsyncMs,
    sqliteSynchronous,
    workerMaxConcurrent: integerOverride(
      env.CENTRAID_WORKER_MAX_CONCURRENT,
      constrained ? 2 : performance ? 12 : 8,
      1,
      32,
    ),
    workerMaxOldGenerationMb: integerOverride(
      env.CENTRAID_WORKER_MAX_OLD_GENERATION_MB,
      constrained ? 128 : performance ? 384 : 256,
      8,
      1_024,
    ),
    workerPoolSize: integerOverride(
      env.CENTRAID_WORKER_POOL_SIZE,
      constrained ? 0 : performance ? 4 : 2,
      0,
      8,
    ),
    replicationConcurrency: integerOverride(
      env.CENTRAID_REPLICATION_CONCURRENCY,
      constrained ? 1 : performance ? 4 : 3,
      1,
      8,
    ),
    staticBrotliQuality: integerOverride(
      env.CENTRAID_STATIC_BROTLI_QUALITY,
      constrained ? 5 : 10,
      0,
      11,
    ),
    staticGzipQuality: integerOverride(env.CENTRAID_STATIC_GZIP_QUALITY, constrained ? 6 : 9, 0, 9),
    vaultMountStrategy: 'eager',
    vaultSweepIntervalMs: hardwareClass === 'constrained' ? 2 * 60 * 60 * 1000 : 60 * 60 * 1000,
    outboxIdleIntervalMs: hardwareClass === 'constrained' ? 2 * 60 * 1000 : 60 * 1000,
  };
}
