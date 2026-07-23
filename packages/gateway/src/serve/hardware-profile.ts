import { availableParallelism, totalmem } from 'node:os';
import {
  parseResourceMode,
  resourceModeLabel,
  type ResourceKnobOverrides,
  type ResourceMode,
} from './resource-mode.js';

export type HardwareClass = 'constrained' | 'standard';
export type { ResourceMode };

/**
 * The six prioritized throughput knobs the resolver attributes a source to
 * (#528 Phase F). The first four accept a durable UI override; the two static
 * compression qualities are env-or-preset only (no prefs key).
 */
export type ResourceKnobName =
  | 'workerMaxConcurrent'
  | 'workerMaxOldGenerationMb'
  | 'workerPoolSize'
  | 'replicationConcurrency'
  | 'staticBrotliQuality'
  | 'staticGzipQuality';

/**
 * Per-knob provenance the client renders as Linked ('preset'), Custom
 * ('prefs'), or env-locked ('env'). `envVar` is the exact operator variable
 * name and is present ONLY when `source === 'env'` (#528 Phase F).
 */
export interface ResourceKnobSource {
  source: 'env' | 'prefs' | 'preset';
  envVar?: string;
}

/** Hard reject bounds per knob — the client mirrors these for input validation. */
export const RESOURCE_KNOB_BOUNDS: Record<ResourceKnobName, { min: number; max: number }> = {
  workerMaxConcurrent: { min: 1, max: 32 },
  workerMaxOldGenerationMb: { min: 8, max: 1_024 },
  workerPoolSize: { min: 0, max: 8 },
  replicationConcurrency: { min: 1, max: 8 },
  staticBrotliQuality: { min: 0, max: 11 },
  staticGzipQuality: { min: 0, max: 9 },
};

/** The operator env var that pins each knob (source-attribution + publish). */
const RESOURCE_KNOB_ENV_VARS: Record<ResourceKnobName, string> = {
  workerMaxConcurrent: 'CENTRAID_WORKER_MAX_CONCURRENT',
  workerMaxOldGenerationMb: 'CENTRAID_WORKER_MAX_OLD_GENERATION_MB',
  workerPoolSize: 'CENTRAID_WORKER_POOL_SIZE',
  replicationConcurrency: 'CENTRAID_REPLICATION_CONCURRENCY',
  staticBrotliQuality: 'CENTRAID_STATIC_BROTLI_QUALITY',
  staticGzipQuality: 'CENTRAID_STATIC_GZIP_QUALITY',
};

export interface GatewayHardwareProfile {
  class: HardwareClass;
  /** Owner/operator Resource mode that selected this profile. */
  resourceMode: ResourceMode;
  /** RAW host CPU count (machine facts), not the cgroup-granted share. */
  cores: number;
  /** RAW host memory (machine facts), not the cgroup-granted share. */
  totalMemoryBytes: number;
  storageFsyncMs: number | null;
  /** A cgroup CPU quota actually clamped the granted share below the raw cores (#528 Phase E). */
  cgroupLimitedCpu: boolean;
  /** A cgroup memory limit actually clamped the granted share below raw memory (#528 Phase E). */
  cgroupLimitedMemory: boolean;
  /** Cumulative CPU steal% since host boot (co-tenant contention), null off-Linux/unknown. */
  stealPercent: number | null;
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
  /** Budget preset framed as the share of the granted host it claims (#528 Phase E). */
  budget: { cpuShare: number; memoryCapMb: number };
  /** Per-knob provenance (env/prefs/preset) for the six prioritized knobs (#528 Phase F). */
  sources: Record<ResourceKnobName, ResourceKnobSource>;
}

/**
 * Budget presets (#528 Phase E). Resource modes are no longer bespoke ternary
 * branches — they select one named budget over the *granted share of the host*
 * (cgroup- and steal-aware effective CPU/memory), not the raw machine. The
 * three presets are byte-identical to the pre-Phase-E class/mode ternaries on
 * plain hosts (guarded by hardware-profile.budget.test.ts); `cpuShare` is the
 * additive share-of-granted-host framing the client renders. Selection:
 * constrained class → conserve; standard + Performance → performance; else
 * balanced.
 */
type BudgetPresetName = 'conserve' | 'balanced' | 'performance';
interface BudgetPreset {
  /** Share of the granted host this budget claims (CPU and memory). */
  cpuShare: number;
  workerMaxConcurrent: number;
  workerMaxOldGenerationMb: number;
  workerPoolSize: number;
  replicationConcurrency: number;
  staticBrotliQuality: number;
  staticGzipQuality: number;
  vaultSweepIntervalMs: number;
  outboxIdleIntervalMs: number;
}

const BUDGET_PRESETS: Record<BudgetPresetName, BudgetPreset> = {
  conserve: {
    cpuShare: 0.5,
    workerMaxConcurrent: 2,
    workerMaxOldGenerationMb: 128,
    workerPoolSize: 0,
    replicationConcurrency: 1,
    staticBrotliQuality: 5,
    staticGzipQuality: 6,
    vaultSweepIntervalMs: 2 * 60 * 60 * 1000,
    outboxIdleIntervalMs: 2 * 60 * 1000,
  },
  balanced: {
    cpuShare: 0.75,
    workerMaxConcurrent: 8,
    workerMaxOldGenerationMb: 256,
    workerPoolSize: 2,
    replicationConcurrency: 3,
    staticBrotliQuality: 10,
    staticGzipQuality: 9,
    vaultSweepIntervalMs: 60 * 60 * 1000,
    outboxIdleIntervalMs: 60 * 1000,
  },
  performance: {
    cpuShare: 1,
    workerMaxConcurrent: 12,
    workerMaxOldGenerationMb: 384,
    workerPoolSize: 4,
    replicationConcurrency: 4,
    staticBrotliQuality: 10,
    staticGzipQuality: 9,
    vaultSweepIntervalMs: 60 * 60 * 1000,
    outboxIdleIntervalMs: 60 * 1000,
  },
};

/**
 * Cumulative CPU steal at or above this percent biases the host to
 * `constrained`: a tenth of the granted CPU is already being taken by
 * co-tenants, so we size for the share we actually keep, not the vCPUs the
 * hypervisor advertises (#528 Phase E).
 */
const STEAL_CONSTRAINED_THRESHOLD_PERCENT = 10;
const CONSTRAINED_CORE_CEILING = 4;
const CONSTRAINED_MEMORY_CEILING_BYTES = 4 * 1024 ** 3;
const SLOW_STORAGE_FSYNC_MS = 8;

/**
 * Resolve one knob through the ONE precedence chain: env > prefs > preset.
 * Env and prefs both clamp through the same [min, max] — env wins when it
 * parses to a valid in-range integer, prefs is next, else the preset baseline
 * carries. A garbage env value (out of range/non-numeric) falls THROUGH to
 * prefs, never silently to preset (#528 Phase F). `envVar` on the returned
 * source is set only when env actually won.
 */
function resolveKnob(params: {
  envRaw: string | undefined;
  envVar: string;
  prefsValue: number | undefined;
  fallback: number;
  min: number;
  max: number;
}): { value: number; source: ResourceKnobSource } {
  if (params.envRaw !== undefined && params.envRaw !== '') {
    const parsed = Number.parseInt(params.envRaw, 10);
    if (Number.isFinite(parsed) && parsed >= params.min) {
      return {
        value: Math.min(parsed, params.max),
        source: { source: 'env', envVar: params.envVar },
      };
    }
  }
  if (
    params.prefsValue !== undefined &&
    Number.isInteger(params.prefsValue) &&
    params.prefsValue >= params.min
  ) {
    return { value: Math.min(params.prefsValue, params.max), source: { source: 'prefs' } };
  }
  return { value: params.fallback, source: { source: 'preset' } };
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
  host: {
    cores: number;
    totalMemoryBytes: number;
    storageFsyncMs: number | null;
    /** cgroup CPU quota clamped the granted share below raw cores (#528 Phase E, additive). */
    cgroupLimitedCpu: boolean;
    /** cgroup memory limit clamped the granted share below raw memory (#528 Phase E, additive). */
    cgroupLimitedMemory: boolean;
    /** Cumulative CPU steal% since host boot, null off-Linux/unknown (#528 Phase E, additive). */
    stealPercent: number | null;
  };
  /** Budget preset framed as the share of the granted host (#528 Phase E, additive). */
  budget: { cpuShare: number; memoryCapMb: number };
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
  /** Per-knob provenance so the client shows Linked/Custom/env-locked (#528 Phase F, additive). */
  sources: Record<ResourceKnobName, ResourceKnobSource>;
  /** Hard reject bounds per knob so the client validates without magic numbers (#528 Phase F, additive). */
  bounds: Record<ResourceKnobName, { min: number; max: number }>;
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
      cgroupLimitedCpu: profile.cgroupLimitedCpu,
      cgroupLimitedMemory: profile.cgroupLimitedMemory,
      stealPercent: profile.stealPercent,
    },
    budget: profile.budget,
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
    sources: profile.sources,
    bounds: RESOURCE_KNOB_BOUNDS,
  };
}

export function formatHardwareProfileDetail(profile: GatewayHardwareProfile): string {
  // Name the share framing when a cgroup quota or steal actually shrank the
  // granted host below the raw machine (#528 Phase E) — otherwise stay terse.
  const shareNote =
    profile.cgroupLimitedCpu || profile.cgroupLimitedMemory || (profile.stealPercent ?? 0) >= 10
      ? '; sized for the share you granted of this host'
      : '';
  return (
    `mode=${resourceModeLabel(profile.resourceMode)} (${profile.resourceMode}); ` +
    `class=${profile.class}; sqlite=${profile.sqliteSynchronous}; ` +
    `workers=${profile.workerMaxConcurrent}x${profile.workerMaxOldGenerationMb}MB; ` +
    `pool=${profile.workerPoolSize}; replication=${profile.replicationConcurrency}; ` +
    `compression=br${profile.staticBrotliQuality}/gz${profile.staticGzipQuality}; ` +
    `mount=${profile.vaultMountStrategy}; sweep=${profile.vaultSweepIntervalMs}ms${shareNote}`
  );
}

export function resolveGatewayHardwareProfile(
  input: {
    cores?: number;
    totalMemoryBytes?: number;
    storageFsyncMs?: number;
    /**
     * cgroup CPU quota as fractional cores (quota/period), or null/absent when
     * unlimited/unknown. Sizes the granted share of the host (#528 Phase E).
     */
    cgroupCpuLimit?: number | null;
    /** cgroup memory limit in bytes, or null/absent when unlimited/unknown (#528 Phase E). */
    cgroupMemoryLimitBytes?: number | null;
    /** Cumulative CPU steal% since host boot, or null/absent when unknown (#528 Phase E). */
    stealPercent?: number | null;
    /** Durable/owner Resource mode (prefs or daemon config). */
    resourceMode?: ResourceMode;
    /**
     * Durable per-knob UI overrides (#528 Phase F). Each present knob wins over
     * its preset baseline but still loses to the matching env var, and clamps
     * through the same bounds. Absent knobs stay Linked to the preset.
     */
    prefsOverrides?: ResourceKnobOverrides;
  } = {},
  env: NodeJS.ProcessEnv = process.env,
): GatewayHardwareProfile {
  const cores = input.cores ?? availableParallelism();
  const totalMemoryBytes = input.totalMemoryBytes ?? totalmem();
  const storageFsyncMs = input.storageFsyncMs ?? null;
  const stealPercent = input.stealPercent ?? null;

  // Effective host = the *granted share*, not the machine. A cgroup CPU quota
  // rounds up to whole cores (a 1.5-core quota still fields two workers), a
  // memory limit clamps the ceiling; both floor at the raw host so an absent
  // or looser limit is a no-op. Class + every knob derive from EFFECTIVE.
  const cpuLimit = input.cgroupCpuLimit ?? null;
  const effectiveCores =
    cpuLimit !== null && cpuLimit > 0 ? Math.max(1, Math.min(cores, Math.ceil(cpuLimit))) : cores;
  const cgroupLimitedCpu = effectiveCores < cores;
  const memoryLimit = input.cgroupMemoryLimitBytes ?? null;
  const effectiveMemoryBytes =
    memoryLimit !== null && memoryLimit > 0
      ? Math.min(totalMemoryBytes, memoryLimit)
      : totalMemoryBytes;
  const cgroupLimitedMemory = effectiveMemoryBytes < totalMemoryBytes;

  const detected: HardwareClass =
    effectiveCores <= CONSTRAINED_CORE_CEILING ||
    effectiveMemoryBytes <= CONSTRAINED_MEMORY_CEILING_BYTES ||
    (storageFsyncMs ?? 0) >= SLOW_STORAGE_FSYNC_MS ||
    (stealPercent ?? 0) >= STEAL_CONSTRAINED_THRESHOLD_PERCENT
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
  // Select the budget over the granted share. Byte-identical to the former
  // class/mode ternaries (hardware-profile.budget.test.ts): constrained class
  // spends the conserve budget, standard Performance the performance budget,
  // everything else balanced.
  const presetName: BudgetPresetName = constrained
    ? 'conserve'
    : performance
      ? 'performance'
      : 'balanced';
  const preset = BUDGET_PRESETS[presetName];

  // Resolve each prioritized knob through the ONE precedence chain
  // (env > prefs > preset) and capture its provenance for the client.
  const prefsOverrides = input.prefsOverrides ?? {};
  const knob = (name: ResourceKnobName, fallback: number, prefsValue?: number) =>
    resolveKnob({
      envRaw: env[RESOURCE_KNOB_ENV_VARS[name]],
      envVar: RESOURCE_KNOB_ENV_VARS[name],
      prefsValue,
      fallback,
      min: RESOURCE_KNOB_BOUNDS[name].min,
      max: RESOURCE_KNOB_BOUNDS[name].max,
    });
  const workerMaxConcurrent = knob(
    'workerMaxConcurrent',
    preset.workerMaxConcurrent,
    prefsOverrides.workerMaxConcurrent,
  );
  const workerMaxOldGenerationMb = knob(
    'workerMaxOldGenerationMb',
    preset.workerMaxOldGenerationMb,
    prefsOverrides.workerMaxOldGenerationMb,
  );
  const workerPoolSize = knob(
    'workerPoolSize',
    preset.workerPoolSize,
    prefsOverrides.workerPoolSize,
  );
  const replicationConcurrency = knob(
    'replicationConcurrency',
    preset.replicationConcurrency,
    prefsOverrides.replicationConcurrency,
  );
  // The two compression qualities have no prefs key — env or preset only.
  const staticBrotliQuality = knob('staticBrotliQuality', preset.staticBrotliQuality);
  const staticGzipQuality = knob('staticGzipQuality', preset.staticGzipQuality);

  return {
    class: hardwareClass,
    resourceMode,
    cores,
    totalMemoryBytes,
    storageFsyncMs,
    cgroupLimitedCpu,
    cgroupLimitedMemory,
    stealPercent,
    sqliteSynchronous,
    workerMaxConcurrent: workerMaxConcurrent.value,
    workerMaxOldGenerationMb: workerMaxOldGenerationMb.value,
    workerPoolSize: workerPoolSize.value,
    replicationConcurrency: replicationConcurrency.value,
    staticBrotliQuality: staticBrotliQuality.value,
    staticGzipQuality: staticGzipQuality.value,
    sources: {
      workerMaxConcurrent: workerMaxConcurrent.source,
      workerMaxOldGenerationMb: workerMaxOldGenerationMb.source,
      workerPoolSize: workerPoolSize.source,
      replicationConcurrency: replicationConcurrency.source,
      staticBrotliQuality: staticBrotliQuality.source,
      staticGzipQuality: staticGzipQuality.source,
    },
    vaultMountStrategy: 'eager',
    vaultSweepIntervalMs: preset.vaultSweepIntervalMs,
    outboxIdleIntervalMs: preset.outboxIdleIntervalMs,
    // Budget claims `cpuShare` of the effective (granted) host; memoryCapMb is
    // that same share of the effective memory in MiB (#528 Phase E, additive).
    budget: {
      cpuShare: preset.cpuShare,
      memoryCapMb: Math.round((effectiveMemoryBytes / 1024 ** 2) * preset.cpuShare),
    },
  };
}
