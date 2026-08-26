/*
 * Owner-facing Resource mode (#521) — one durable preference feeding the
 * existing hardware-profile resolver (#456). Modes NEVER add a second policy
 * path: they only select class and throughput tier; Auto keeps boot-time
 * detection. Pref key lives under the gateway preferences table (`gateway.db`)
 * so the shell writes it via PUT `/_centraid-user/prefs` — no env vars.
 */

export type ResourceMode = "auto" | "conserve" | "balanced" | "performance";

export const RESOURCE_MODES: readonly ResourceMode[] = [
  "auto",
  "conserve",
  "balanced",
  "performance",
] as const;

/** Device-prefs key — runtime wins (docs/config-ownership.md). */
export const RESOURCE_MODE_PREF_KEY = "gateway.resourceMode";

/**
 * Prioritized per-knob UI overrides (#528): mode selects a budget preset;
 * these keys pin an individual knob above/below it from the shell. Absent key
 * = "Linked". Precedence per knob is env > prefs > preset, resolved in the ONE
 * hardware-profile resolver — never a second policy path. Positive integers;
 * the resolver clamps them like the matching env var.
 */
export interface ResourceKnobOverrides {
  workerMaxConcurrent?: number;
  workerMaxOldGenerationMb?: number;
  workerPoolSize?: number;
  replicationConcurrency?: number;
}

/** Device-prefs keys for the prioritized knobs — runtime wins, apply on next boot. */
export const RESOURCE_KNOB_PREF_KEYS: Record<
  keyof ResourceKnobOverrides,
  string
> = {
  workerMaxConcurrent: "gateway.resource.workerMaxConcurrent",
  workerMaxOldGenerationMb: "gateway.resource.workerMaxOldGenerationMb",
  workerPoolSize: "gateway.resource.workerPoolSize",
  replicationConcurrency: "gateway.resource.replicationConcurrency",
};

/** Accept only a safe, finite, positive integer; anything else is Linked. */
function safePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

/**
 * Read durable knob overrides from the flat prefs KV. Garbage (strings,
 * negatives, floats, NaN, missing) is silently dropped — a hand-edited pref
 * can never widen a bound or crash boot; the resolver still clamps survivors.
 */
export function parseResourceKnobPrefs(
  prefs: Record<string, unknown>
): ResourceKnobOverrides {
  const out: ResourceKnobOverrides = {};
  for (const knob of Object.keys(
    RESOURCE_KNOB_PREF_KEYS
  ) as (keyof ResourceKnobOverrides)[]) {
    const parsed = safePositiveInteger(prefs[RESOURCE_KNOB_PREF_KEYS[knob]]);
    if (parsed !== undefined) out[knob] = parsed;
  }
  return out;
}

export function isResourceMode(value: unknown): value is ResourceMode {
  return (
    value === "auto" ||
    value === "conserve" ||
    value === "balanced" ||
    value === "performance"
  );
}

export function parseResourceMode(value: unknown): ResourceMode | undefined {
  return isResourceMode(value) ? value : undefined;
}

/** Resolve the effective mode: operator env, then durable device prefs (owner UI), then daemon config option, else Auto. */
export function resolveResourceMode(input: {
  env?: NodeJS.ProcessEnv;
  optionsMode?: unknown;
  prefsMode?: unknown;
}): ResourceMode {
  const env = input.env ?? process.env;
  const fromEnv = parseResourceMode(env.CENTRAID_RESOURCE_MODE);
  if (fromEnv) return fromEnv;
  const fromPrefs = parseResourceMode(input.prefsMode);
  if (fromPrefs) return fromPrefs;
  const fromOptions = parseResourceMode(input.optionsMode);
  if (fromOptions) return fromOptions;
  return "auto";
}

export function resourceModeLabel(mode: ResourceMode): string {
  switch (mode) {
    case "auto":
      return "Auto";
    case "conserve":
      return "Conserve";
    case "balanced":
      return "Balanced";
    case "performance":
      return "Performance";
  }
}

export function formatEventLoopDetail(sample: {
  eventLoopLagP50Ms: number;
  eventLoopLagP99Ms: number;
  eventLoopLagMaxMs: number;
}): string {
  const numbers = `p50 ${sample.eventLoopLagP50Ms.toFixed(1)} ms · p99 ${sample.eventLoopLagP99Ms.toFixed(1)} ms · max ${sample.eventLoopLagMaxMs.toFixed(1)} ms`;
  if (sample.eventLoopLagP99Ms >= 50) {
    return `Busy: pausing non-urgent background work so apps stay responsive (${numbers})`;
  }
  return `Responsive (${numbers})`;
}

export function formatLoadShedDeferringDetail(p99Ms: number): string {
  return `Busy: pausing backups, sweeps, and other background work so apps stay responsive (event-loop p99 ${p99Ms.toFixed(1)} ms)`;
}

export function formatLoadShedForcedPassDetail(
  p99Ms: number,
  deferredMs: number
): string {
  const seconds = Math.round(deferredMs / 1000);
  return `Still busy (event-loop p99 ${p99Ms.toFixed(1)} ms); running one deferred background pass after ${seconds}s so work cannot starve`;
}

export function formatLoadShedClearedDetail(): string {
  return "Event-loop pressure cleared; background work resumes";
}

/** Owner-triggered background pause (#528 Phase B). Durability work — WAL/fsync and the consent outbox — is NEVER gated, so the copy names only loops that actually stop. */
export function formatBackgroundPausedDetail(until: string | null): string {
  const scope =
    "Paused non-urgent background work (vault sweeps, backup retention)";
  return until === null
    ? `${scope} until you resume`
    : `${scope} until ${until}`;
}

export function formatBackgroundResumedDetail(): string {
  return "Background work resumed";
}

/** Host power-context posture detail (#528 Phase D). Posture is a COURTESY, not a fault — stays `ok`, explains the deferral, never an alarm or durable mode flip. */
export function formatPowerPostureDeferringDetail(
  reason: "on-battery" | "low-battery" | "thermal",
  kind: "battery" | "mains" | "server"
): string {
  const scope =
    "deferring non-urgent background work (sweeps, backup retention)";
  switch (reason) {
    case "low-battery":
      return `Battery low; ${scope} to save power. Durability and consent work continue.`;
    case "thermal":
      return `Host under thermal pressure; ${scope} to shed heat. Durability and consent work continue.`;
    case "on-battery":
      return `Running on ${kind === "server" ? "battery" : "battery power"}; ${scope} until back on mains. Durability and consent work continue.`;
  }
}

export function formatPowerPostureNormalDetail(): string {
  return "On mains/steady power; background work runs normally";
}

export function formatRss(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
