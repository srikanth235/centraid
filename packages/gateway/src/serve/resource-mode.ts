/*
 * Owner-facing Resource mode (#521) — one durable preference that feeds the
 * existing hardware-profile resolver (issue #456 A7). Modes never invent a
 * second policy path: Conserve/Balanced/Performance only select class and
 * throughput tier; Auto keeps boot-time detection.
 *
 * Pref key lives under the device prefs store (`prefs.json`) so the shell
 * can write it via PUT `/_centraid-user/prefs` without env vars.
 */

export type ResourceMode = 'auto' | 'conserve' | 'balanced' | 'performance';

export const RESOURCE_MODES: readonly ResourceMode[] = [
  'auto',
  'conserve',
  'balanced',
  'performance',
] as const;

/** Device-prefs key — runtime wins (docs/config-ownership.md). */
export const RESOURCE_MODE_PREF_KEY = 'gateway.resourceMode';

export function isResourceMode(value: unknown): value is ResourceMode {
  return (
    value === 'auto' || value === 'conserve' || value === 'balanced' || value === 'performance'
  );
}

export function parseResourceMode(value: unknown): ResourceMode | undefined {
  return isResourceMode(value) ? value : undefined;
}

/**
 * Resolve the effective Resource mode. Operator env wins, then durable
 * device prefs (owner UI), then daemon config option, else Auto.
 */
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
  return 'auto';
}

export function resourceModeLabel(mode: ResourceMode): string {
  switch (mode) {
    case 'auto':
      return 'Auto';
    case 'conserve':
      return 'Conserve';
    case 'balanced':
      return 'Balanced';
    case 'performance':
      return 'Performance';
  }
}

/** Human-readable event-loop probe detail (shared by health API + UI). */
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

/** Human-readable load-shed component detail while pressure is active. */
export function formatLoadShedDeferringDetail(p99Ms: number): string {
  return `Busy: pausing backups, sweeps, and other background work so apps stay responsive (event-loop p99 ${p99Ms.toFixed(1)} ms)`;
}

/** Human-readable load-shed detail when a forced pass is admitted after max deferral. */
export function formatLoadShedForcedPassDetail(p99Ms: number, deferredMs: number): string {
  const seconds = Math.round(deferredMs / 1000);
  return `Still busy (event-loop p99 ${p99Ms.toFixed(1)} ms); running one deferred background pass after ${seconds}s so work cannot starve`;
}

export function formatLoadShedClearedDetail(): string {
  return 'Event-loop pressure cleared; background work resumes';
}

/**
 * Human-readable detail for the owner-triggered background pause (#528
 * Phase B). Durability work — WAL/fsync and the consent outbox — is never
 * gated, so the copy names only the loops that actually stop.
 */
export function formatBackgroundPausedDetail(until: string | null): string {
  const scope = 'Paused non-urgent background work (vault sweeps, backup retention)';
  return until === null ? `${scope} until you resume` : `${scope} until ${until}`;
}

export function formatBackgroundResumedDetail(): string {
  return 'Background work resumed';
}

export function formatRss(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB'] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
