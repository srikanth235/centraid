import { availableParallelism, totalmem } from 'node:os';

export type HardwareClass = 'constrained' | 'standard';

export interface GatewayHardwareProfile {
  class: HardwareClass;
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

export function resolveGatewayHardwareProfile(
  input: {
    cores?: number;
    totalMemoryBytes?: number;
    storageFsyncMs?: number;
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
  const requested = env.CENTRAID_HARDWARE_PROFILE;
  const hardwareClass: HardwareClass =
    requested === 'constrained' || requested === 'standard' ? requested : detected;
  const syncOverride = env.CENTRAID_SQLITE_SYNCHRONOUS?.toUpperCase();
  const sqliteSynchronous =
    syncOverride === 'FULL' || syncOverride === 'NORMAL'
      ? syncOverride
      : requested === 'constrained'
        ? 'NORMAL'
        : 'FULL';
  const constrained = hardwareClass === 'constrained';
  return {
    class: hardwareClass,
    cores,
    totalMemoryBytes,
    storageFsyncMs,
    sqliteSynchronous,
    workerMaxConcurrent: integerOverride(
      env.CENTRAID_WORKER_MAX_CONCURRENT,
      constrained ? 2 : 8,
      1,
      32,
    ),
    workerMaxOldGenerationMb: integerOverride(
      env.CENTRAID_WORKER_MAX_OLD_GENERATION_MB,
      constrained ? 128 : 256,
      8,
      1_024,
    ),
    workerPoolSize: integerOverride(env.CENTRAID_WORKER_POOL_SIZE, constrained ? 0 : 2, 0, 8),
    replicationConcurrency: integerOverride(
      env.CENTRAID_REPLICATION_CONCURRENCY,
      constrained ? 1 : 3,
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
