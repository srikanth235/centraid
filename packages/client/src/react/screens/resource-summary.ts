import { formatBytes } from "../../format.js";

export type ResourceMode = "auto" | "conserve" | "balanced" | "performance";

export interface ResourceProfileHost {
  cores: number;
  totalMemoryBytes: number;
  storageFsyncMs: number | null;
}

export interface ResourceProfileResolved {
  workerMaxConcurrent: number;
  workerMaxOldGenerationMb: number;
  workerPoolSize: number;
  replicationConcurrency: number;
  sqliteSynchronous: "FULL" | "NORMAL";
  vaultSweepIntervalMs: number;
  outboxIdleIntervalMs: number;
}

export type ResourceKnobKey =
  | "workerMaxConcurrent"
  | "workerMaxOldGenerationMb"
  | "workerPoolSize"
  | "replicationConcurrency";

export interface ResourceKnobSource {
  source: "env" | "prefs" | "preset";
  envVar?: string;
}

export interface ResourceKnobBounds {
  min: number;
  max: number;
}

export interface ResourceProfileDTO {
  class: "constrained" | "standard";
  mode: "auto" | "conserve" | "balanced" | "performance";
  host: ResourceProfileHost;
  resolved: ResourceProfileResolved;
  sources?: Record<ResourceKnobKey, ResourceKnobSource>;
  bounds?: Record<ResourceKnobKey, ResourceKnobBounds>;
}

export interface BackgroundPauseDTO {
  paused: boolean;
  until: string | null;
}

export interface ResourceFactRow {
  label: string;
  value: string;
}

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
    harnessRuns: { runs: number; busyMs: number; cpuSeconds: number | null };
  };
  backgroundTimerFiresLastHour: number | null;
}

export interface ResourceUsageRow {
  label: string;
  value: string;
  note?: string;
}

const MS_PER_HOUR = 3_600_000;

export function formatGb(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function formatMbAsGb(megabytes: number): string {
  if (!Number.isFinite(megabytes) || megabytes < 0) return "—";
  return `${(megabytes / 1024).toFixed(1)} GB`;
}

export function formatFriendlyMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60)
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
  const minutes = seconds / 60;
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} min`;
}

export function formatBudgetSummary(profile: ResourceProfileDTO): string {
  const { workerMaxConcurrent, workerMaxOldGenerationMb } = profile.resolved;
  const memGb = formatMbAsGb(workerMaxConcurrent * workerMaxOldGenerationMb);
  const workers = workerMaxConcurrent;
  const cores = profile.host.cores;
  const workerWord = workers === 1 ? "worker" : "workers";
  const coreWord = cores === 1 ? "core" : "cores";
  return `Up to ~${memGb} memory · ${workers} background ${workerWord} on ${cores} ${coreWord}`;
}

export function msUntilTonight(now: number): number {
  const target = new Date(now);
  target.setHours(20, 0, 0, 0);
  if (target.getTime() <= now) target.setDate(target.getDate() + 1);
  return target.getTime() - now;
}

export function formatPauseUntil(until: string | null): string {
  if (!until) return "Paused until you resume";
  const at = new Date(until);
  if (Number.isNaN(at.getTime())) return "Paused until you resume";
  const hh = String(at.getHours()).padStart(2, "0");
  const mm = String(at.getMinutes()).padStart(2, "0");
  return `Paused until ${hh}:${mm}`;
}

export function hostFactRows(profile: ResourceProfileDTO): ResourceFactRow[] {
  const { host } = profile;
  return [
    { label: "CPU cores", value: String(host.cores) },
    { label: "Total memory", value: formatGb(host.totalMemoryBytes) },
    {
      label: "Storage fsync",
      value:
        host.storageFsyncMs === null
          ? "not measured"
          : `${host.storageFsyncMs.toFixed(1)} ms`,
    },
  ];
}

export function resolvedKnobRows(
  profile: ResourceProfileDTO
): ResourceFactRow[] {
  const r = profile.resolved;
  return [
    {
      label: "Workers × heap",
      value: `${r.workerMaxConcurrent} × ${r.workerMaxOldGenerationMb} MB`,
    },
    { label: "Warm pool", value: String(r.workerPoolSize) },
    { label: "Replication", value: `${r.replicationConcurrency} concurrent` },
    { label: "SQLite durability", value: r.sqliteSynchronous },
    {
      label: "Vault sweep",
      value: `every ${formatFriendlyMs(r.vaultSweepIntervalMs)}`,
    },
    {
      label: "Outbox idle poll",
      value: `every ${formatFriendlyMs(r.outboxIdleIntervalMs)}`,
    },
  ];
}

export const PAUSE_ONE_HOUR_MS = MS_PER_HOUR;

export type PowerContextKind = "battery" | "mains" | "server";

export interface PowerContextState {
  kind: PowerContextKind;
  battery: { percent: number | null; charging: boolean | null } | null;
  deferringBackgroundWork: boolean;
  reason: "on-battery" | "low-battery" | "thermal" | null;
  source: "os-probe" | "client-push" | "none";
  stealPercent: number | null;
  updatedAt: number | null;
}

const STEAL_NOTE_THRESHOLD_PCT = 5;

export function powerPostureLine(power: PowerContextState): string | null {
  if (power.battery !== null) {
    if (!power.deferringBackgroundWork) return null;
    switch (power.reason) {
      case "on-battery":
        return "On battery — heavy background work deferred";
      case "low-battery":
        return "Battery low — background work paused until charging";
      case "thermal":
        return "Thermal pressure — backing off";
      case null:
        return null;
      default:
        return null;
    }
  }
  if (
    power.kind === "server" &&
    power.stealPercent !== null &&
    power.stealPercent >= STEAL_NOTE_THRESHOLD_PCT
  ) {
    return `Shared host: ${Math.round(power.stealPercent)}% CPU steal observed — sizing accounts for the share you actually get`;
  }
  return null;
}

export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60)
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 60)
    return `${minutes < 10 ? minutes.toFixed(1) : Math.round(minutes)} min`;
  return `${(minutes / 60).toFixed(1)} h`;
}

export function formatBusyMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return formatSeconds(ms / 1000);
}

export function processUsageRows(usage: ResourceUsageDTO): ResourceUsageRow[] {
  const { cpuSecondsTotal, currentRssBytes, peakRssBytes } = usage.process;
  return [
    { label: "CPU time", value: formatSeconds(cpuSecondsTotal) },
    { label: "Memory now", value: formatBytes(currentRssBytes) },
    { label: "Peak memory", value: formatBytes(peakRssBytes) },
  ];
}

export function subsystemUsageRows(
  usage: ResourceUsageDTO
): ResourceUsageRow[] {
  const s = usage.subsystems;
  return [
    {
      label: "Worker pool",
      value: `${s.workerPool.tasks} tasks · ${formatBusyMs(s.workerPool.busyMs)} active`,
    },
    {
      label: "Replication",
      value: `${s.replication.passes} passes · ${formatBytes(s.replication.bytesReplicated)} · ${formatBusyMs(s.replication.busyMs)} active`,
    },
    {
      label: "Backup",
      value: `${s.backup.drains} drains · ${formatBytes(s.backup.bytesUploaded)} uploaded · ${formatBusyMs(s.backup.busyMs)} active`,
    },
    {
      label: "Sweeps",
      value: `${s.sweeps.passes} passes · ${formatBusyMs(s.sweeps.busyMs)} active`,
    },
    {
      label: "Harness runs",
      value: `${s.harnessRuns.runs} runs · ${formatBusyMs(s.harnessRuns.busyMs)} active`,
      note: "Measured, not limited by Conserve.",
    },
  ];
}

export type TunableKnobKey =
  | "workerMaxConcurrent"
  | "workerMaxOldGenerationMb"
  | "workerPoolSize"
  | "replicationConcurrency";

export type ResourceKnobPrefs = Record<TunableKnobKey, number | null>;

export const RESOURCE_KNOB_PREF_PREFIX = "gateway.resource.";

export function knobPrefKey(key: TunableKnobKey): string {
  return `${RESOURCE_KNOB_PREF_PREFIX}${key}`;
}

interface KnobMeta {
  key: TunableKnobKey;
  label: string;
  tier: "P0" | "P1";
}

const KNOB_META: readonly KnobMeta[] = [
  { key: "workerMaxConcurrent", label: "Worker concurrency", tier: "P0" },
  { key: "workerMaxOldGenerationMb", label: "Worker memory (MB)", tier: "P0" },
  { key: "workerPoolSize", label: "Warm pool size", tier: "P1" },
  {
    key: "replicationConcurrency",
    label: "Replication concurrency",
    tier: "P1",
  },
];

export interface KnobRowFacts {
  key: TunableKnobKey;
  label: string;
  tier: "P0" | "P1";
  running: number;
  bounds: ResourceKnobBounds;
  source: "env" | "prefs" | "preset";
  envVar?: string;
}

export function knobRowsFromProfile(
  profile: ResourceProfileDTO
): KnobRowFacts[] | null {
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
    if (src.source === "env" && src.envVar) facts.envVar = src.envVar;
    return facts;
  });
}

export function parseResourceKnobPrefs(
  prefs: Record<string, unknown>
): ResourceKnobPrefs {
  const read = (key: TunableKnobKey): number | null => {
    const raw = prefs[knobPrefKey(key)];
    return typeof raw === "number" && Number.isInteger(raw) && raw > 0
      ? raw
      : null;
  };
  return {
    workerMaxConcurrent: read("workerMaxConcurrent"),
    workerMaxOldGenerationMb: read("workerMaxOldGenerationMb"),
    workerPoolSize: read("workerPoolSize"),
    replicationConcurrency: read("replicationConcurrency"),
  };
}

export function validateKnobDraft(
  raw: string,
  bounds: ResourceKnobBounds
): { ok: true; value: number } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, error: "Enter a value." };
  const n = Number(trimmed);
  if (!Number.isInteger(n)) return { ok: false, error: "Whole numbers only." };
  if (n <= 0) return { ok: false, error: "Must be greater than 0." };
  if (n < bounds.min || n > bounds.max) {
    return { ok: false, error: `Out of range (${bounds.min}–${bounds.max}).` };
  }
  return { ok: true, value: n };
}

export function knobPending(
  running: number,
  desired: number | null,
  bootSource: "env" | "prefs" | "preset"
): boolean {
  if (bootSource === "env") return false;
  if (desired !== null) return desired !== running;
  return bootSource === "prefs";
}

export function knobSoftWarnings(params: {
  effectiveConcurrent: number;
  effectiveMemMb: number;
  hostCores: number;
  hostMemoryBytes: number;
}): { concurrencyOverCores: boolean; memoryOverHalf: boolean } {
  const { effectiveConcurrent, effectiveMemMb, hostCores, hostMemoryBytes } =
    params;
  const halfHostMb = hostMemoryBytes / 1024 ** 2 / 2;
  return {
    concurrencyOverCores: hostCores > 0 && effectiveConcurrent > hostCores,
    memoryOverHalf:
      halfHostMb > 0 && effectiveConcurrent * effectiveMemMb > halfHostMb,
  };
}
