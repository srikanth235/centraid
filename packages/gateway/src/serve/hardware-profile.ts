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
  /** Lazy mount remains gated by A5's scheduler index; correctness selects eager. */
  vaultMountStrategy: 'eager';
  vaultSweepIntervalMs: number;
  outboxIdleIntervalMs: number;
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
      : hardwareClass === 'constrained'
        ? 'NORMAL'
        : 'FULL';
  return {
    class: hardwareClass,
    cores,
    totalMemoryBytes,
    storageFsyncMs,
    sqliteSynchronous,
    workerMaxConcurrent: hardwareClass === 'constrained' ? 2 : 8,
    workerMaxOldGenerationMb: hardwareClass === 'constrained' ? 128 : 256,
    workerPoolSize: hardwareClass === 'constrained' ? 0 : 2,
    replicationConcurrency: hardwareClass === 'constrained' ? 1 : 3,
    staticBrotliQuality: hardwareClass === 'constrained' ? 5 : 10,
    vaultMountStrategy: 'eager',
    vaultSweepIntervalMs: hardwareClass === 'constrained' ? 2 * 60 * 60 * 1000 : 60 * 60 * 1000,
    outboxIdleIntervalMs: hardwareClass === 'constrained' ? 2 * 60 * 1000 : 60 * 1000,
  };
}
