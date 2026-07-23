// Pure formatting helpers for the Resource card's progressive-disclosure
// ladder (issue #528 Phase A+B). Kept free of React so the L1 budget summary
// and L2 "how we sized this" math stay unit-testable, and so ResourceModeCard
// + ResourceCardDetails stay under the 500-line governance cap.

/** Host facts the gateway measured, from `health.metrics.resourceProfile.host`. */
export interface ResourceProfileHost {
  cores: number;
  totalMemoryBytes: number;
  /** `null` when the gateway never measured storage fsync latency. */
  storageFsyncMs: number | null;
}

/** The knobs the resolver derived, from `health.metrics.resourceProfile.resolved`. */
export interface ResourceProfileResolved {
  workerMaxConcurrent: number;
  workerMaxOldGenerationMb: number;
  workerPoolSize: number;
  replicationConcurrency: number;
  staticBrotliQuality: number;
  staticGzipQuality: number;
  sqliteSynchronous: 'FULL' | 'NORMAL';
  vaultSweepIntervalMs: number;
  outboxIdleIntervalMs: number;
}

/** Structured resource profile on `health.metrics.resourceProfile` (issue #528). */
export interface ResourceProfileDTO {
  class: 'constrained' | 'standard';
  mode: 'auto' | 'conserve' | 'balanced' | 'performance';
  host: ResourceProfileHost;
  resolved: ResourceProfileResolved;
}

/** Background-work pause state on `health.metrics.backgroundPause` (issue #528). */
export interface BackgroundPauseDTO {
  paused: boolean;
  /** ISO timestamp the pause lifts, or `null` for indefinite / not paused. */
  until: string | null;
}

/** One label/value pair rendered in the L2 detail lists. */
export interface ResourceFactRow {
  label: string;
  value: string;
}

const MS_PER_HOUR = 3_600_000;

/** Format a byte count as GB with one decimal, e.g. `8.0 GB`. */
export function formatGb(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** Format a MB count as GB with one decimal, e.g. `2.5 GB`. */
export function formatMbAsGb(megabytes: number): string {
  if (!Number.isFinite(megabytes) || megabytes < 0) return '—';
  return `${(megabytes / 1024).toFixed(1)} GB`;
}

/** Friendly duration for the L2 interval knobs: `800 ms`, `30s`, `5 min`. */
export function formatFriendlyMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
  const minutes = seconds / 60;
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} min`;
}

/**
 * L1 budget line in user units first — memory is `workerMaxConcurrent ×
 * workerMaxOldGenerationMb` (MB→GB, one decimal); worker/core counts come
 * from the resolved knobs and host. Attributed to the gateway host by the
 * caller, never the browser device.
 */
export function formatBudgetSummary(profile: ResourceProfileDTO): string {
  const { workerMaxConcurrent, workerMaxOldGenerationMb } = profile.resolved;
  const memGb = formatMbAsGb(workerMaxConcurrent * workerMaxOldGenerationMb);
  const workers = workerMaxConcurrent;
  const cores = profile.host.cores;
  const workerWord = workers === 1 ? 'worker' : 'workers';
  const coreWord = cores === 1 ? 'core' : 'cores';
  return `Up to ~${memGb} memory · ${workers} background ${workerWord} on ${cores} ${coreWord}`;
}

/**
 * Milliseconds from `now` (epoch ms) until the next local 20:00. When `now`
 * is already at or past 20:00, targets 20:00 tomorrow. Powers the "Until
 * tonight" pause choice.
 */
export function msUntilTonight(now: number): number {
  const target = new Date(now);
  target.setHours(20, 0, 0, 0);
  if (target.getTime() <= now) target.setDate(target.getDate() + 1);
  return target.getTime() - now;
}

/** Paused-state label: a local clock time, or the indefinite phrasing. */
export function formatPauseUntil(until: string | null): string {
  if (!until) return 'Paused until you resume';
  const at = new Date(until);
  if (Number.isNaN(at.getTime())) return 'Paused until you resume';
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  return `Paused until ${hh}:${mm}`;
}

/** L2 host facts — cores, total memory, storage fsync (or "not measured"). */
export function hostFactRows(profile: ResourceProfileDTO): ResourceFactRow[] {
  const { host } = profile;
  return [
    { label: 'CPU cores', value: String(host.cores) },
    { label: 'Total memory', value: formatGb(host.totalMemoryBytes) },
    {
      label: 'Storage fsync',
      value: host.storageFsyncMs === null ? 'not measured' : `${host.storageFsyncMs.toFixed(1)} ms`,
    },
  ];
}

/** L2 resolved knobs, in friendly units — read-only "how we sized this". */
export function resolvedKnobRows(profile: ResourceProfileDTO): ResourceFactRow[] {
  const r = profile.resolved;
  return [
    {
      label: 'Workers × heap',
      value: `${r.workerMaxConcurrent} × ${r.workerMaxOldGenerationMb} MB`,
    },
    { label: 'Warm pool', value: String(r.workerPoolSize) },
    { label: 'Replication', value: `${r.replicationConcurrency} concurrent` },
    { label: 'SQLite durability', value: r.sqliteSynchronous },
    { label: 'Vault sweep', value: `every ${formatFriendlyMs(r.vaultSweepIntervalMs)}` },
    { label: 'Outbox idle poll', value: `every ${formatFriendlyMs(r.outboxIdleIntervalMs)}` },
    {
      label: 'Compression',
      value: `brotli q${r.staticBrotliQuality} · gzip q${r.staticGzipQuality}`,
    },
  ];
}

/** The three L0 pause durations, in the order the card renders them. */
export const PAUSE_ONE_HOUR_MS = MS_PER_HOUR;
