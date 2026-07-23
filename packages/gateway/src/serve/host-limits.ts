/*
 * Host resource limits probe (#528 Phase E) — reads the cgroup CPU/memory
 * quota and one cumulative CPU-steal sample at gateway boot so the hardware
 * profile sizes the *granted share of the host*, not the raw machine. A
 * container capped at 2 vCPU on a 64-core box should be sized like a 2-core
 * host; a noisy-neighbour VM losing a tenth of its CPU to steal should be
 * treated as constrained.
 *
 * Every read is failure-tolerant: a missing file, a parse miss, or a
 * non-Linux host all resolve to `null` (no limit known), which the resolver
 * treats as a plain unconstrained host. The fs reader and steal sampler are
 * injectable so the parsing is unit-testable without a real cgroup mount.
 *
 * The steal sampler is REUSED from power-context.ts (#528 Phase D) rather than
 * writing a second `/proc/stat` parser — this module only converts its one
 * cumulative `{steal,total}` sample into a boot-time percent.
 */

import { readFileSync } from 'node:fs';
import { defaultStealSampler, type CpuStealSample } from './power-context.js';

export interface HostLimits {
  /** cgroup CPU quota as fractional cores (quota/period), or null when unlimited/unknown. */
  cgroupCpuLimit: number | null;
  /** cgroup memory limit in bytes, or null when unlimited/unknown. */
  cgroupMemoryLimitBytes: number | null;
  /** Cumulative CPU steal% since host boot, or null off-Linux/unknown. */
  stealPercent: number | null;
}

export interface HostLimitsReaders {
  /** Read a file to text, or null on any error (missing/permission/etc.). */
  readText?: (path: string) => string | null;
  /** One cumulative `/proc/stat` steal sample; defaults to the Phase D sampler. */
  stealSample?: () => CpuStealSample | null;
  platform?: NodeJS.Platform;
}

// cgroup v2 unified hierarchy.
const CGROUP_V2_CPU_MAX = '/sys/fs/cgroup/cpu.max';
const CGROUP_V2_MEMORY_MAX = '/sys/fs/cgroup/memory.max';
// cgroup v1 fallback (separate cpu / memory controllers).
const CGROUP_V1_CPU_QUOTA = '/sys/fs/cgroup/cpu/cpu.cfs_quota_us';
const CGROUP_V1_CPU_PERIOD = '/sys/fs/cgroup/cpu/cpu.cfs_period_us';
const CGROUP_V1_MEMORY_LIMIT = '/sys/fs/cgroup/memory/memory.limit_in_bytes';

// cgroup v1 writes a near-2^63 sentinel for "no limit"; JS parseInt of that
// string lands well above 2^53, so anything that large is treated as unset.
// No real container caps memory at petabytes.
const MEMORY_NO_LIMIT_FLOOR = 2 ** 53;

function defaultReadText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Parse cgroup v2 `cpu.max` ("max" | "<quota> <period>") to fractional cores. */
function parseCpuMaxV2(text: string): number | null {
  const [quota, period] = text.trim().split(/\s+/);
  if (quota === undefined || quota === 'max') return null;
  const q = Number(quota);
  const p = Number(period ?? '100000');
  if (!Number.isFinite(q) || !Number.isFinite(p) || p <= 0 || q <= 0) return null;
  return q / p;
}

/** Parse cgroup v1 quota/period (quota -1 ⇒ unlimited) to fractional cores. */
function parseCpuCfsV1(quotaText: string | null, periodText: string | null): number | null {
  if (quotaText === null) return null;
  const q = Number(quotaText.trim());
  if (!Number.isFinite(q) || q <= 0) return null;
  const p = periodText === null ? 100_000 : Number(periodText.trim());
  if (!Number.isFinite(p) || p <= 0) return null;
  return q / p;
}

function parseMemoryLimit(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === 'max' || trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0 || n >= MEMORY_NO_LIMIT_FLOOR) return null;
  return n;
}

function readCgroupCpuLimit(readText: (p: string) => string | null): number | null {
  const v2 = readText(CGROUP_V2_CPU_MAX);
  if (v2 !== null) return parseCpuMaxV2(v2);
  return parseCpuCfsV1(readText(CGROUP_V1_CPU_QUOTA), readText(CGROUP_V1_CPU_PERIOD));
}

function readCgroupMemoryLimit(readText: (p: string) => string | null): number | null {
  const v2 = readText(CGROUP_V2_MEMORY_MAX);
  if (v2 !== null) return parseMemoryLimit(v2);
  const v1 = readText(CGROUP_V1_MEMORY_LIMIT);
  return v1 === null ? null : parseMemoryLimit(v1);
}

/** Convert one cumulative steal sample into a boot-time percent since host boot. */
function stealPercentFromSample(sample: CpuStealSample | null): number | null {
  if (!sample || sample.total <= 0) return null;
  return Math.max(0, Math.min(100, (sample.steal / sample.total) * 100));
}

/**
 * Read the granted-share limits once at boot. Failure-tolerant end to end:
 * any unreadable file or non-Linux host yields nulls, which the hardware
 * profile treats as an unconstrained plain host.
 */
export function probeHostLimits(readers: HostLimitsReaders = {}): HostLimits {
  const platform = readers.platform ?? process.platform;
  const readText = readers.readText ?? defaultReadText;
  const stealSample = readers.stealSample ?? defaultStealSampler(platform);
  return {
    cgroupCpuLimit: readCgroupCpuLimit(readText),
    cgroupMemoryLimitBytes: readCgroupMemoryLimit(readText),
    stealPercent: stealPercentFromSample(stealSample()),
  };
}
