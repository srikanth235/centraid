import { expect, test } from 'vitest';
import { probeHostLimits } from './host-limits.js';

/** Build an injected fs reader from a path→contents map (missing paths ⇒ null). */
function reader(files: Record<string, string>): (path: string) => string | null {
  return (path) => files[path] ?? null;
}

test('reads a cgroup v2 CPU + memory limit', () => {
  const limits = probeHostLimits({
    platform: 'linux',
    readText: reader({
      '/sys/fs/cgroup/cpu.max': '200000 100000\n',
      '/sys/fs/cgroup/memory.max': '2147483648\n',
    }),
    stealSample: () => null,
  });
  expect(limits.cgroupCpuLimit).toBe(2);
  expect(limits.cgroupMemoryLimitBytes).toBe(2_147_483_648);
});

test('cgroup v2 "max" means unlimited', () => {
  const limits = probeHostLimits({
    platform: 'linux',
    readText: reader({
      '/sys/fs/cgroup/cpu.max': 'max 100000\n',
      '/sys/fs/cgroup/memory.max': 'max\n',
    }),
    stealSample: () => null,
  });
  expect(limits.cgroupCpuLimit).toBeNull();
  expect(limits.cgroupMemoryLimitBytes).toBeNull();
});

test('falls back to cgroup v1 when v2 files are absent', () => {
  const limits = probeHostLimits({
    platform: 'linux',
    readText: reader({
      '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '150000\n',
      '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000\n',
      '/sys/fs/cgroup/memory/memory.limit_in_bytes': '1073741824\n',
    }),
    stealSample: () => null,
  });
  expect(limits.cgroupCpuLimit).toBeCloseTo(1.5);
  expect(limits.cgroupMemoryLimitBytes).toBe(1_073_741_824);
});

test('cgroup v1 quota -1 and the memory no-limit sentinel are unlimited', () => {
  const limits = probeHostLimits({
    platform: 'linux',
    readText: reader({
      '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '-1\n',
      '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000\n',
      '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712\n',
    }),
    stealSample: () => null,
  });
  expect(limits.cgroupCpuLimit).toBeNull();
  expect(limits.cgroupMemoryLimitBytes).toBeNull();
});

test('garbage and missing files resolve to nulls, never throw', () => {
  const limits = probeHostLimits({
    platform: 'linux',
    readText: reader({
      '/sys/fs/cgroup/cpu.max': 'not-a-number\n',
      '/sys/fs/cgroup/memory.max': 'garbage',
    }),
    stealSample: () => null,
  });
  expect(limits.cgroupCpuLimit).toBeNull();
  expect(limits.cgroupMemoryLimitBytes).toBeNull();

  const empty = probeHostLimits({
    platform: 'linux',
    readText: () => null,
    stealSample: () => null,
  });
  expect(empty).toEqual({
    cgroupCpuLimit: null,
    cgroupMemoryLimitBytes: null,
    stealPercent: null,
  });
});

test('converts one cumulative steal sample into a boot-time percent', () => {
  const limits = probeHostLimits({
    platform: 'linux',
    readText: () => null,
    stealSample: () => ({ steal: 150, total: 1000 }),
  });
  expect(limits.stealPercent).toBeCloseTo(15);
});

test('a null steal sample yields a null percent', () => {
  const limits = probeHostLimits({
    platform: 'linux',
    readText: () => null,
    stealSample: () => null,
  });
  expect(limits.stealPercent).toBeNull();
});
