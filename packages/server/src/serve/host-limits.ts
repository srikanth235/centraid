import { readFileSync } from "node:fs";

import { defaultStealSampler } from "./power-context.js";
import type { CpuStealSample } from "./power-context.js";

export interface HostLimits {
  cgroupCpuLimit: number | null;
  cgroupMemoryLimitBytes: number | null;
  stealPercent: number | null;
}

export interface HostLimitsReaders {
  readText?: (path: string) => string | null;
  stealSample?: () => CpuStealSample | null;
  platform?: NodeJS.Platform;
}

const CGROUP_V2_CPU_MAX = "/sys/fs/cgroup/cpu.max";
const CGROUP_V2_MEMORY_MAX = "/sys/fs/cgroup/memory.max";
const CGROUP_V1_CPU_QUOTA = "/sys/fs/cgroup/cpu/cpu.cfs_quota_us";
const CGROUP_V1_CPU_PERIOD = "/sys/fs/cgroup/cpu/cpu.cfs_period_us";
const CGROUP_V1_MEMORY_LIMIT = "/sys/fs/cgroup/memory/memory.limit_in_bytes";

const MEMORY_NO_LIMIT_FLOOR = 2 ** 53;

function defaultReadText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function parseCpuMaxV2(text: string): number | null {
  const [quota, period] = text.trim().split(/\s+/u);
  if (quota === undefined || quota === "max") return null;
  const q = Number(quota);
  const p = Number(period ?? "100000");
  if (!Number.isFinite(q) || !Number.isFinite(p) || p <= 0 || q <= 0)
    return null;
  return q / p;
}

function parseCpuCfsV1(
  quotaText: string | null,
  periodText: string | null
): number | null {
  if (quotaText === null) return null;
  const q = Number(quotaText.trim());
  if (!Number.isFinite(q) || q <= 0) return null;
  const p = periodText === null ? 100_000 : Number(periodText.trim());
  if (!Number.isFinite(p) || p <= 0) return null;
  return q / p;
}

function parseMemoryLimit(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "max" || trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0 || n >= MEMORY_NO_LIMIT_FLOOR) return null;
  return n;
}

function readCgroupCpuLimit(
  readText: (p: string) => string | null
): number | null {
  const v2 = readText(CGROUP_V2_CPU_MAX);
  if (v2 !== null) return parseCpuMaxV2(v2);
  return parseCpuCfsV1(
    readText(CGROUP_V1_CPU_QUOTA),
    readText(CGROUP_V1_CPU_PERIOD)
  );
}

function readCgroupMemoryLimit(
  readText: (p: string) => string | null
): number | null {
  const v2 = readText(CGROUP_V2_MEMORY_MAX);
  if (v2 !== null) return parseMemoryLimit(v2);
  const v1 = readText(CGROUP_V1_MEMORY_LIMIT);
  return v1 === null ? null : parseMemoryLimit(v1);
}

function stealPercentFromSample(sample: CpuStealSample | null): number | null {
  if (!sample || sample.total <= 0) return null;
  return Math.max(0, Math.min(100, (sample.steal / sample.total) * 100));
}

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
