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

/** Knob keys the resolver derives; the first four are owner-tunable (issue #528 Phase F). */
export type ResourceKnobKey =
  | 'workerMaxConcurrent'
  | 'workerMaxOldGenerationMb'
  | 'workerPoolSize'
  | 'replicationConcurrency'
  | 'staticBrotliQuality'
  | 'staticGzipQuality';

/** Provenance of one resolved knob, from `resourceProfile.sources` (issue #528 Phase F). */
export interface ResourceKnobSource {
  source: 'env' | 'prefs' | 'preset';
  /** The environment variable name when `source === 'env'`. */
  envVar?: string;
}

/** Accepted inclusive range for one knob, from `resourceProfile.bounds` (issue #528 Phase F). */
export interface ResourceKnobBounds {
  min: number;
  max: number;
}

/** Structured resource profile on `health.metrics.resourceProfile` (issue #528). */
export interface ResourceProfileDTO {
  class: 'constrained' | 'standard';
  mode: 'auto' | 'conserve' | 'balanced' | 'performance';
  host: ResourceProfileHost;
  resolved: ResourceProfileResolved;
  /**
   * Per-knob provenance (issue #528 Phase F). Additive — absent on older
   * gateways, in which case the L3 "Tune" rung does not render at all.
   */
  sources?: Record<ResourceKnobKey, ResourceKnobSource>;
  /** Per-knob accepted range (issue #528 Phase F). Additive — see `sources`. */
  bounds?: Record<ResourceKnobKey, ResourceKnobBounds>;
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

/**
 * Measured resource actuals on `health.metrics.resourceUsage` (issue #528
 * Phase C). Mirrors `CentraidResourceUsage` (centraid-api.d.ts) field for
 * field — proxies only (CPU time, bytes, activity), never wattage.
 */
export interface ResourceUsageDTO {
  sinceMs: number;
  process: {
    cpuSecondsTotal: number;
    currentRssBytes: number;
    peakRssBytes: number;
  };
  subsystems: {
    workerPool: { tasks: number; busyMs: number };
    replication: { passes: number; bytesReplicated: number; busyMs: number };
    backup: { drains: number; bytesUploaded: number; busyMs: number };
    sweeps: { passes: number; busyMs: number };
    /** `cpuSeconds` is `null` in v1 — agent runs aren't separately CPU-accounted. */
    agentRuns: { runs: number; busyMs: number; cpuSeconds: number | null };
  };
  backgroundTimerFiresLastHour: number | null;
}

/**
 * One measured subsystem row for the resource receipt. `note` carries a
 * clarifying caveat (e.g. the agent-runs "measured, not limited by Conserve"
 * label the issue mandates).
 */
export interface ResourceUsageRow {
  label: string;
  value: string;
  note?: string;
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

// ── Power-context posture (issue #528 Phase D) ──────────────────────────────
// Battery/thermal chrome appears ONLY when the gateway host actually has a
// battery; a mains/server host shows a server-relevant fact (CPU steal) or
// nothing. Kept React-free so the copy derivation stays unit-testable.

export type PowerContextKind = 'battery' | 'mains' | 'server';

/**
 * React-local mirror of `CentraidPowerContext` (centraid-api.d.ts), field for
 * field. Describes the gateway HOST's power situation — never the browser or
 * phone viewing the screen.
 */
export interface PowerContextState {
  kind: PowerContextKind;
  /** `null` ⇒ host has no battery — no battery chrome, ever. */
  battery: { percent: number | null; charging: boolean | null } | null;
  deferringBackgroundWork: boolean;
  reason: 'on-battery' | 'low-battery' | 'thermal' | null;
  source: 'os-probe' | 'client-push' | 'none';
  stealPercent: number | null;
  updatedAt: number | null;
}

/** Only surface the shared-host steal fact when the share lost is meaningful. */
const STEAL_NOTE_THRESHOLD_PCT = 5;

/**
 * The posture line for the Resource card, or `null` when nothing should
 * render. Battery/thermal chrome appears ONLY when the host has a battery
 * (`battery !== null`) AND posture is active — an idle battery host and every
 * mains host render nothing. A shared server host shows the CPU-steal fact
 * instead, but only when steal is meaningful (≥ 5%). The copy is host-neutral;
 * the caller attributes it to the gateway's host, never the viewing device.
 */
export function powerPostureLine(power: PowerContextState): string | null {
  if (power.battery !== null) {
    if (!power.deferringBackgroundWork) return null;
    switch (power.reason) {
      case 'on-battery':
        return 'On battery — heavy background work deferred';
      case 'low-battery':
        return 'Battery low — background work paused until charging';
      case 'thermal':
        return 'Thermal pressure — backing off';
      default:
        return null;
    }
  }
  // No battery: never battery/thermal chrome. Only the server steal fact.
  if (
    power.kind === 'server' &&
    power.stealPercent !== null &&
    power.stealPercent >= STEAL_NOTE_THRESHOLD_PCT
  ) {
    return `Shared host: ${Math.round(power.stealPercent)}% CPU steal observed — sizing accounts for the share you actually get`;
  }
  return null;
}

// ── Resource receipt (issue #528 Phase C) ───────────────────────────────────
// Pure formatting + row-building for ResourceReceiptPanel — measured actuals,
// kept React-free so the byte/duration math stays unit-testable.

/** Adaptive byte count — `512 B`, `8.4 KB`, `120 MB`, `2.3 GB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}

/** CPU/active time given in seconds — `4.2s`, `37s`, `12 min`, `1.4 h`. */
export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes < 10 ? minutes.toFixed(1) : Math.round(minutes)} min`;
  return `${(minutes / 60).toFixed(1)} h`;
}

/** Active (busy) time given in milliseconds — reuses the seconds scale. */
export function formatBusyMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return formatSeconds(ms / 1000);
}

/** Process-level actuals — CPU time, current + peak memory. */
export function processUsageRows(usage: ResourceUsageDTO): ResourceUsageRow[] {
  const { cpuSecondsTotal, currentRssBytes, peakRssBytes } = usage.process;
  return [
    { label: 'CPU time', value: formatSeconds(cpuSecondsTotal) },
    { label: 'Memory now', value: formatBytes(currentRssBytes) },
    { label: 'Peak memory', value: formatBytes(peakRssBytes) },
  ];
}

/**
 * Per-subsystem actuals in the order the receipt renders them. Agent runs
 * carry the explicit "measured, not limited by Conserve" caveat plus the
 * v1 null-CPU note, so Conserve never appears to promise what it can't govern.
 */
export function subsystemUsageRows(usage: ResourceUsageDTO): ResourceUsageRow[] {
  const s = usage.subsystems;
  return [
    {
      label: 'Worker pool',
      value: `${s.workerPool.tasks} tasks · ${formatBusyMs(s.workerPool.busyMs)} active`,
    },
    {
      label: 'Replication',
      value: `${s.replication.passes} passes · ${formatBytes(s.replication.bytesReplicated)} · ${formatBusyMs(s.replication.busyMs)} active`,
    },
    {
      label: 'Backup',
      value: `${s.backup.drains} drains · ${formatBytes(s.backup.bytesUploaded)} uploaded · ${formatBusyMs(s.backup.busyMs)} active`,
    },
    {
      label: 'Sweeps',
      value: `${s.sweeps.passes} passes · ${formatBusyMs(s.sweeps.busyMs)} active`,
    },
    {
      label: 'Agent runs',
      value: `${s.agentRuns.runs} runs · ${formatBusyMs(s.agentRuns.busyMs)} active`,
      note: 'Measured, not limited by Conserve. CPU time for agent runs isn’t separately measurable yet.',
    },
  ];
}

// ── L3 "Tune" rung: advanced knobs (issue #528 Phase F) ─────────────────────
// The four owner-tunable knobs, their prefs plumbing, and the pure validation
// used by ResourceAdvancedKnobs. Kept React-free so the bounds/warning math
// stays unit-testable and the component stays under the 500-line cap. Only the
// first four knobs are tunable; compression quality stays resolver-only.

/** The four owner-tunable knob keys, in the order the L3 rung renders them. */
export type TunableKnobKey =
  | 'workerMaxConcurrent'
  | 'workerMaxOldGenerationMb'
  | 'workerPoolSize'
  | 'replicationConcurrency';

/** Saved knob overrides (desired), keyed by knob. `null` ⇒ Linked (no override). */
export type ResourceKnobPrefs = Record<TunableKnobKey, number | null>;

/** Pref-key prefix for knob overrides — `gateway.resource.<knob>`. */
export const RESOURCE_KNOB_PREF_PREFIX = 'gateway.resource.';

/** The durable prefs key a knob override writes to. */
export function knobPrefKey(key: TunableKnobKey): string {
  return `${RESOURCE_KNOB_PREF_PREFIX}${key}`;
}

/** Static per-knob presentation — label + disclosure tier. */
interface KnobMeta {
  key: TunableKnobKey;
  label: string;
  tier: 'P0' | 'P1';
}

const KNOB_META: readonly KnobMeta[] = [
  { key: 'workerMaxConcurrent', label: 'Worker concurrency', tier: 'P0' },
  { key: 'workerMaxOldGenerationMb', label: 'Worker memory (MB)', tier: 'P0' },
  { key: 'workerPoolSize', label: 'Warm pool size', tier: 'P1' },
  { key: 'replicationConcurrency', label: 'Replication concurrency', tier: 'P1' },
];

/** One row's profile-derived facts (before the saved-pref/desired merge). */
export interface KnobRowFacts {
  key: TunableKnobKey;
  label: string;
  tier: 'P0' | 'P1';
  /** Current running value from `resolved` — what the gateway applied at boot. */
  running: number;
  bounds: ResourceKnobBounds;
  source: 'env' | 'prefs' | 'preset';
  /** Environment variable name when `source === 'env'`. */
  envVar?: string;
}

/**
 * Build the four knob rows from the profile, or `null` when the gateway did
 * not send `sources` + `bounds` (older gateway) — the whole L3 rung then hides.
 */
export function knobRowsFromProfile(profile: ResourceProfileDTO): KnobRowFacts[] | null {
  const { sources, bounds } = profile;
  if (!sources || !bounds) return null;
  return KNOB_META.map((meta) => {
    const src = sources[meta.key];
    const facts: KnobRowFacts = {
      key: meta.key,
      label: meta.label,
      tier: meta.tier,
      running: profile.resolved[meta.key],
      bounds: bounds[meta.key],
      source: src.source,
    };
    if (src.source === 'env' && src.envVar) facts.envVar = src.envVar;
    return facts;
  });
}

/** Read saved knob overrides from the prefs record; non-positive-integers ⇒ Linked. */
export function parseResourceKnobPrefs(prefs: Record<string, unknown>): ResourceKnobPrefs {
  const read = (key: TunableKnobKey): number | null => {
    const raw = prefs[knobPrefKey(key)];
    return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : null;
  };
  return {
    workerMaxConcurrent: read('workerMaxConcurrent'),
    workerMaxOldGenerationMb: read('workerMaxOldGenerationMb'),
    workerPoolSize: read('workerPoolSize'),
    replicationConcurrency: read('replicationConcurrency'),
  };
}

/** Hard-validate a draft entry against its bounds. Positive integers only. */
export function validateKnobDraft(
  raw: string,
  bounds: ResourceKnobBounds,
): { ok: true; value: number } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, error: 'Enter a value.' };
  const n = Number(trimmed);
  if (!Number.isInteger(n)) return { ok: false, error: 'Whole numbers only.' };
  if (n <= 0) return { ok: false, error: 'Must be greater than 0.' };
  if (n < bounds.min || n > bounds.max) {
    return { ok: false, error: `Out of range (${bounds.min}–${bounds.max}).` };
  }
  return { ok: true, value: n };
}

/**
 * A knob is restart-pending when the desired override differs from the running
 * value, or when a boot-time override was just cleared back to Linked. Env
 * knobs never go pending — the operator variable wins and can't be tuned here.
 */
export function knobPending(
  running: number,
  desired: number | null,
  bootSource: 'env' | 'prefs' | 'preset',
): boolean {
  if (bootSource === 'env') return false;
  if (desired !== null) return desired !== running;
  return bootSource === 'prefs';
}

/**
 * Soft (save-allowed) warnings for the worker-sizing knobs. `effectiveMemMb` is
 * the per-worker heap; the product against the worker count is compared to half
 * the host's memory. Amber, never blocking — the owner may know better than the
 * heuristic.
 */
export function knobSoftWarnings(params: {
  effectiveConcurrent: number;
  effectiveMemMb: number;
  hostCores: number;
  hostMemoryBytes: number;
}): { concurrencyOverCores: boolean; memoryOverHalf: boolean } {
  const { effectiveConcurrent, effectiveMemMb, hostCores, hostMemoryBytes } = params;
  const halfHostMb = hostMemoryBytes / 1024 ** 2 / 2;
  return {
    concurrencyOverCores: hostCores > 0 && effectiveConcurrent > hostCores,
    memoryOverHalf: halfHostMb > 0 && effectiveConcurrent * effectiveMemMb > halfHostMb,
  };
}
