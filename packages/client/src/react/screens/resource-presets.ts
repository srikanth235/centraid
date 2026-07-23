// Client-side mirror of the gateway's BUDGET_PRESETS
// (packages/gateway/src/serve/hardware-profile.ts). The gateway resolves only
// the ACTIVE mode against the host and reports it on health
// (`resourceProfile.resolved`); to let an owner SEE what each mode grants
// before committing, the Compare dialog needs every preset's baseline. These
// knob values are host-independent (only the derived memory cap / core count
// vary with the machine), so mirroring them is faithful. Keep in sync with the
// gateway table if the presets ever change (issue #528 follow-up).

import { formatMbAsGb } from './resource-summary.js';

/** The three concrete presets. `auto` is not a preset — it defers to one of these. */
export type PresetMode = 'conserve' | 'balanced' | 'performance';

/** One budget preset — the knobs a mode selects, before host resolution. */
export interface ResourcePreset {
  /** Fraction of the granted host CPU the gateway may use. */
  cpuShare: number;
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

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

export const RESOURCE_PRESETS: Record<PresetMode, ResourcePreset> = {
  conserve: {
    cpuShare: 0.5,
    workerMaxConcurrent: 2,
    workerMaxOldGenerationMb: 128,
    workerPoolSize: 0,
    replicationConcurrency: 1,
    staticBrotliQuality: 5,
    staticGzipQuality: 6,
    sqliteSynchronous: 'NORMAL',
    vaultSweepIntervalMs: 2 * HOUR,
    outboxIdleIntervalMs: 2 * MIN,
  },
  balanced: {
    cpuShare: 0.75,
    workerMaxConcurrent: 8,
    workerMaxOldGenerationMb: 256,
    workerPoolSize: 2,
    replicationConcurrency: 3,
    staticBrotliQuality: 10,
    staticGzipQuality: 9,
    sqliteSynchronous: 'FULL',
    vaultSweepIntervalMs: HOUR,
    outboxIdleIntervalMs: MIN,
  },
  performance: {
    cpuShare: 1,
    workerMaxConcurrent: 12,
    workerMaxOldGenerationMb: 384,
    workerPoolSize: 4,
    replicationConcurrency: 4,
    staticBrotliQuality: 10,
    staticGzipQuality: 9,
    sqliteSynchronous: 'FULL',
    vaultSweepIntervalMs: HOUR,
    outboxIdleIntervalMs: MIN,
  },
};

/** Whole-hour / whole-minute intervals read cleaner as `2 h` / `1 min` than `120 min`. */
export function formatInterval(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms >= HOUR) {
    const h = ms / HOUR;
    return `${Number.isInteger(h) ? h : h.toFixed(1)} h`;
  }
  if (ms >= MIN) {
    const m = ms / MIN;
    return `${Number.isInteger(m) ? m : m.toFixed(1)} min`;
  }
  return `${Math.round(ms / 1000)}s`;
}

/**
 * The compact hint under each mode chip: workers · memory ceiling (e.g.
 * `8 · 2.0 GB`). `auto` has no fixed budget — it detects — so it reads
 * `detect`.
 */
export function presetHint(mode: 'auto' | PresetMode): string {
  if (mode === 'auto') return 'detect';
  const p = RESOURCE_PRESETS[mode];
  return `${p.workerMaxConcurrent} · ${formatMbAsGb(p.workerMaxConcurrent * p.workerMaxOldGenerationMb)}`;
}

/** One attribute row of the Compare dialog: a label, a tooltip, and a value per preset. */
export interface CompareRow {
  key: string;
  label: string;
  /** Plain-English gloss shown on hover (title attr). */
  hint: string;
  values: Record<PresetMode, string>;
}

const PRESET_MODES: readonly PresetMode[] = ['conserve', 'balanced', 'performance'];

function byPreset(fn: (p: ResourcePreset) => string): Record<PresetMode, string> {
  return {
    conserve: fn(RESOURCE_PRESETS.conserve),
    balanced: fn(RESOURCE_PRESETS.balanced),
    performance: fn(RESOURCE_PRESETS.performance),
  };
}

/** The full comparison, top (most tangible) to bottom (most technical). */
export function resourceCompareRows(): CompareRow[] {
  return [
    {
      key: 'cpu',
      label: 'CPU budget',
      hint: "Share of this machine's granted CPU the gateway may use for background work.",
      values: byPreset((p) => `${Math.round(p.cpuShare * 100)}%`),
    },
    {
      key: 'workers',
      label: 'Background workers',
      hint: 'How many background jobs may run at the same time.',
      values: byPreset((p) => String(p.workerMaxConcurrent)),
    },
    {
      key: 'memory',
      label: 'Memory ceiling',
      hint: 'Upper bound across all background workers (workers × per-worker heap).',
      values: byPreset((p) => formatMbAsGb(p.workerMaxConcurrent * p.workerMaxOldGenerationMb)),
    },
    {
      key: 'pool',
      label: 'Warm pool',
      hint: 'Workers kept ready so background jobs skip a cold start.',
      values: byPreset((p) => (p.workerPoolSize === 0 ? 'none' : String(p.workerPoolSize))),
    },
    {
      key: 'replication',
      label: 'Replication',
      hint: 'Parallel backup / replication streams to remote storage.',
      values: byPreset((p) => `${p.replicationConcurrency}×`),
    },
    {
      key: 'sweep',
      label: 'Vault sweep',
      hint: 'How often the vault housekeeping sweep runs.',
      values: byPreset((p) => formatInterval(p.vaultSweepIntervalMs)),
    },
    {
      key: 'poll',
      label: 'Outbox poll',
      hint: 'How often the outbox checks for work when idle.',
      values: byPreset((p) => formatInterval(p.outboxIdleIntervalMs)),
    },
    {
      key: 'compression',
      label: 'Compression',
      hint: 'Static-asset compression effort — higher is smaller on the wire but costs more CPU.',
      values: byPreset((p) => `brotli q${p.staticBrotliQuality}`),
    },
    {
      key: 'durability',
      label: 'Data durability',
      hint: 'SQLite fsync durability. Relaxed trades a little crash-safety for less disk churn.',
      values: byPreset((p) => (p.sqliteSynchronous === 'NORMAL' ? 'Relaxed' : 'Full')),
    },
  ];
}

export { PRESET_MODES };
