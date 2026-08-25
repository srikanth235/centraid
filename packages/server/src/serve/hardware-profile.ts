import { availableParallelism, totalmem } from "node:os";

import { parseResourceMode, resourceModeLabel } from "./resource-mode.js";
import type { ResourceKnobOverrides, ResourceMode } from "./resource-mode.js";

export { type ResourceMode } from "./resource-mode.js";
export type HardwareClass = "constrained" | "standard";

/** Each takes a durable UI override (#528). No static compression quality here (#799). */
export type ResourceKnobName =
  | "workerMaxConcurrent"
  | "workerMaxOldGenerationMb"
  | "workerPoolSize"
  | "replicationConcurrency";

/** `envVar` is the operator variable name, present ONLY when `source === 'env'` (#528). */
export interface ResourceKnobSource {
  source: "env" | "prefs" | "preset";
  envVar?: string;
}

/** Hard reject bounds; the client mirrors these. */
export const RESOURCE_KNOB_BOUNDS: Record<
  ResourceKnobName,
  { min: number; max: number }
> = {
  workerMaxConcurrent: { min: 1, max: 32 },
  workerMaxOldGenerationMb: { min: 8, max: 1_024 },
  workerPoolSize: { min: 0, max: 8 },
  replicationConcurrency: { min: 1, max: 8 },
};

const RESOURCE_KNOB_ENV_VARS: Record<ResourceKnobName, string> = {
  workerMaxConcurrent: "CENTRAID_WORKER_MAX_CONCURRENT",
  workerMaxOldGenerationMb: "CENTRAID_WORKER_MAX_OLD_GENERATION_MB",
  workerPoolSize: "CENTRAID_WORKER_POOL_SIZE",
  replicationConcurrency: "CENTRAID_REPLICATION_CONCURRENCY",
};

export interface GatewayHardwareProfile {
  class: HardwareClass;
  resourceMode: ResourceMode;
  /** RAW host facts, not the cgroup-granted share. */
  cores: number;
  totalMemoryBytes: number;
  storageFsyncMs: number | null;
  cgroupLimitedCpu: boolean;
  cgroupLimitedMemory: boolean;
  /** Cumulative steal% since host boot; null off-Linux/unknown. */
  stealPercent: number | null;
  sqliteSynchronous: "FULL" | "NORMAL";
  workerMaxConcurrent: number;
  workerMaxOldGenerationMb: number;
  workerPoolSize: number;
  replicationConcurrency: number;
  /** Lazy mount stays gated on the scheduler index; correctness selects eager. */
  vaultMountStrategy: "eager";
  vaultSweepIntervalMs: number;
  outboxIdleIntervalMs: number;
  budget: { cpuShare: number; memoryCapMb: number };
  sources: Record<ResourceKnobName, ResourceKnobSource>;
}

/**
 * A budget is spent over the *granted share* of the host, never the raw
 * machine (#528); values are pinned by hardware-profile.budget.test.ts.
 */
type BudgetPresetName = "conserve" | "balanced" | "performance";
interface BudgetPreset {
  cpuShare: number;
  workerMaxConcurrent: number;
  workerMaxOldGenerationMb: number;
  workerPoolSize: number;
  replicationConcurrency: number;
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
    vaultSweepIntervalMs: 2 * 60 * 60 * 1000,
    outboxIdleIntervalMs: 2 * 60 * 1000,
  },
  balanced: {
    cpuShare: 0.75,
    workerMaxConcurrent: 8,
    workerMaxOldGenerationMb: 256,
    workerPoolSize: 2,
    replicationConcurrency: 3,
    vaultSweepIntervalMs: 60 * 60 * 1000,
    outboxIdleIntervalMs: 60 * 1000,
  },
  performance: {
    cpuShare: 1,
    workerMaxConcurrent: 12,
    workerMaxOldGenerationMb: 384,
    workerPoolSize: 4,
    replicationConcurrency: 4,
    vaultSweepIntervalMs: 60 * 60 * 1000,
    outboxIdleIntervalMs: 60 * 1000,
  },
};

/** At or above this steal%, size for the share we keep, not the advertised vCPUs (#528). */
const STEAL_CONSTRAINED_THRESHOLD_PERCENT = 10;
const CONSTRAINED_CORE_CEILING = 4;
const CONSTRAINED_MEMORY_CEILING_BYTES = 4 * 1024 ** 3;
const SLOW_STORAGE_FSYNC_MS = 8;

/**
 * The ONE chain: env > prefs > preset, all clamped through [min, max]. A bad
 * env value falls THROUGH to prefs, never straight to preset (#528).
 */
function resolveKnob(params: {
  envRaw: string | undefined;
  envVar: string;
  prefsValue: number | undefined;
  fallback: number;
  min: number;
  max: number;
}): { value: number; source: ResourceKnobSource } {
  if (params.envRaw !== undefined && params.envRaw !== "") {
    const parsed = Math.trunc(Number(params.envRaw));
    if (Number.isFinite(parsed) && parsed >= params.min) {
      return {
        value: Math.min(parsed, params.max),
        source: { source: "env", envVar: params.envVar },
      };
    }
  }
  if (
    params.prefsValue !== undefined &&
    Number.isInteger(params.prefsValue) &&
    params.prefsValue >= params.min
  ) {
    return {
      value: Math.min(params.prefsValue, params.max),
      source: { source: "prefs" },
    };
  }
  return { value: params.fallback, source: { source: "preset" } };
}

/** Applies only when `CENTRAID_HARDWARE_PROFILE` is unpinned; Auto keeps detection. */
export function hardwareClassForResourceMode(
  mode: ResourceMode,
  detected: HardwareClass
): HardwareClass {
  switch (mode) {
    case "auto":
      return detected;
    case "conserve":
      return "constrained";
    case "balanced":
    case "performance":
      return "standard";
  }
}

/** The only source of the shape `GET /_gateway/health` publishes (#528). */
export interface StructuredResourceProfile {
  class: HardwareClass;
  mode: ResourceMode;
  host: {
    cores: number;
    totalMemoryBytes: number;
    storageFsyncMs: number | null;
    cgroupLimitedCpu: boolean;
    cgroupLimitedMemory: boolean;
    stealPercent: number | null;
  };
  budget: { cpuShare: number; memoryCapMb: number };
  resolved: {
    workerMaxConcurrent: number;
    workerMaxOldGenerationMb: number;
    workerPoolSize: number;
    replicationConcurrency: number;
    sqliteSynchronous: "FULL" | "NORMAL";
    vaultSweepIntervalMs: number;
    outboxIdleIntervalMs: number;
  };
  sources: Record<ResourceKnobName, ResourceKnobSource>;
  bounds: Record<ResourceKnobName, { min: number; max: number }>;
}

export function toStructuredResourceProfile(
  profile: GatewayHardwareProfile
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
      sqliteSynchronous: profile.sqliteSynchronous,
      vaultSweepIntervalMs: profile.vaultSweepIntervalMs,
      outboxIdleIntervalMs: profile.outboxIdleIntervalMs,
    },
    sources: profile.sources,
    bounds: RESOURCE_KNOB_BOUNDS,
  };
}

export function formatHardwareProfileDetail(
  profile: GatewayHardwareProfile
): string {
  // Name the share framing only when a quota or steal actually shrank the host (#528).
  const shareNote =
    profile.cgroupLimitedCpu ||
    profile.cgroupLimitedMemory ||
    (profile.stealPercent ?? 0) >= 10
      ? "; sized for the share you granted of this host"
      : "";
  return (
    `mode=${resourceModeLabel(profile.resourceMode)} (${profile.resourceMode}); ` +
    `class=${profile.class}; sqlite=${profile.sqliteSynchronous}; ` +
    `workers=${profile.workerMaxConcurrent}x${profile.workerMaxOldGenerationMb}MB; ` +
    `pool=${profile.workerPoolSize}; replication=${profile.replicationConcurrency}; ` +
    `mount=${profile.vaultMountStrategy}; sweep=${profile.vaultSweepIntervalMs}ms${shareNote}`
  );
}

export function resolveGatewayHardwareProfile(
  input: {
    cores?: number;
    totalMemoryBytes?: number;
    storageFsyncMs?: number;
    /** cgroup CPU quota as fractional cores (quota/period); null/absent = unlimited. */
    cgroupCpuLimit?: number | null;
    cgroupMemoryLimitBytes?: number | null;
    stealPercent?: number | null;
    resourceMode?: ResourceMode;
    /** Per-knob overrides: beat the preset, lose to env, clamp through the same bounds (#528). */
    prefsOverrides?: ResourceKnobOverrides;
  } = {},
  env: NodeJS.ProcessEnv = process.env
): GatewayHardwareProfile {
  const cores = input.cores ?? availableParallelism();
  const totalMemoryBytes = input.totalMemoryBytes ?? totalmem();
  const storageFsyncMs = input.storageFsyncMs ?? null;
  const stealPercent = input.stealPercent ?? null;

  // Class and every knob derive from the EFFECTIVE (granted) host, not the
  // machine; CPU quota rounds up to whole cores, both floor at the raw host.
  const cpuLimit = input.cgroupCpuLimit ?? null;
  const effectiveCores =
    cpuLimit !== null && cpuLimit > 0
      ? Math.max(1, Math.min(cores, Math.ceil(cpuLimit)))
      : cores;
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
      ? "constrained"
      : "standard";

  const resourceMode: ResourceMode =
    input.resourceMode ??
    parseResourceMode(env.CENTRAID_RESOURCE_MODE) ??
    "auto";

  const requested = env.CENTRAID_HARDWARE_PROFILE;
  const hardwareClass: HardwareClass =
    requested === "constrained" || requested === "standard"
      ? requested
      : hardwareClassForResourceMode(resourceMode, detected);

  // NORMAL durability only on an explicit constrained choice (env pin or
  // Conserve), never on auto-detection of a small host (#456).
  const syncOverride = env.CENTRAID_SQLITE_SYNCHRONOUS?.toUpperCase();
  const explicitConstrained =
    requested === "constrained" ||
    (requested === undefined && resourceMode === "conserve");
  const sqliteSynchronous =
    syncOverride === "FULL" || syncOverride === "NORMAL"
      ? syncOverride
      : explicitConstrained
        ? "NORMAL"
        : "FULL";

  const constrained = hardwareClass === "constrained";
  const performance = !constrained && resourceMode === "performance";
  const presetName: BudgetPresetName = constrained
    ? "conserve"
    : performance
      ? "performance"
      : "balanced";
  const preset = BUDGET_PRESETS[presetName];

  const prefsOverrides = input.prefsOverrides ?? {};
  const knob = (
    name: ResourceKnobName,
    fallback: number,
    prefsValue?: number
  ) =>
    resolveKnob({
      envRaw: env[RESOURCE_KNOB_ENV_VARS[name]],
      envVar: RESOURCE_KNOB_ENV_VARS[name],
      prefsValue,
      fallback,
      min: RESOURCE_KNOB_BOUNDS[name].min,
      max: RESOURCE_KNOB_BOUNDS[name].max,
    });
  const workerMaxConcurrent = knob(
    "workerMaxConcurrent",
    preset.workerMaxConcurrent,
    prefsOverrides.workerMaxConcurrent
  );
  const workerMaxOldGenerationMb = knob(
    "workerMaxOldGenerationMb",
    preset.workerMaxOldGenerationMb,
    prefsOverrides.workerMaxOldGenerationMb
  );
  const workerPoolSize = knob(
    "workerPoolSize",
    preset.workerPoolSize,
    prefsOverrides.workerPoolSize
  );
  const replicationConcurrency = knob(
    "replicationConcurrency",
    preset.replicationConcurrency,
    prefsOverrides.replicationConcurrency
  );

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
    sources: {
      workerMaxConcurrent: workerMaxConcurrent.source,
      workerMaxOldGenerationMb: workerMaxOldGenerationMb.source,
      workerPoolSize: workerPoolSize.source,
      replicationConcurrency: replicationConcurrency.source,
    },
    vaultMountStrategy: "eager",
    vaultSweepIntervalMs: preset.vaultSweepIntervalMs,
    outboxIdleIntervalMs: preset.outboxIdleIntervalMs,
    // memoryCapMb is `cpuShare` of the EFFECTIVE memory, in MiB (#528).
    budget: {
      cpuShare: preset.cpuShare,
      memoryCapMb: Math.round(
        (effectiveMemoryBytes / 1024 ** 2) * preset.cpuShare
      ),
    },
  };
}
