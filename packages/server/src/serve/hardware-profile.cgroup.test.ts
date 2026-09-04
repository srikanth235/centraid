import { describe, expect, test } from "vitest";

import { resolveGatewayHardwareProfile } from "./hardware-profile.js";

describe("hardware-profile: host limits", () => {
  test("cgroup CPU quota sizes a big host down to its granted share", () => {
    const profile = resolveGatewayHardwareProfile(
      {
        cores: 16,
        totalMemoryBytes: 64 * 1024 ** 3,
        storageFsyncMs: 1,
        cgroupCpuLimit: 2,
      },
      {}
    );
    expect(profile).toMatchObject({
      class: "constrained",
      cgroupLimitedCpu: true,
      cgroupLimitedMemory: false,
      workerMaxConcurrent: 2,
      workerPoolSize: 1,
      replicationConcurrency: 1,
      sqliteSynchronous: "FULL",
    });
    expect(profile.cores).toBe(16);
  });

  test("a cgroup quota at or above the raw cores does not constrain", () => {
    const profile = resolveGatewayHardwareProfile(
      {
        cores: 8,
        totalMemoryBytes: 16 * 1024 ** 3,
        storageFsyncMs: 1,
        cgroupCpuLimit: 8,
      },
      {}
    );
    expect(profile).toMatchObject({
      class: "standard",
      cgroupLimitedCpu: false,
    });
  });

  test("a fractional cgroup quota rounds up to whole granted cores", () => {
    const profile = resolveGatewayHardwareProfile(
      {
        cores: 8,
        totalMemoryBytes: 16 * 1024 ** 3,
        storageFsyncMs: 1,
        cgroupCpuLimit: 6.5,
      },
      {}
    );
    expect(profile).toMatchObject({
      class: "standard",
      cgroupLimitedCpu: true,
    });
  });

  test("cgroup memory limit constrains a big host and shrinks the budget cap", () => {
    const profile = resolveGatewayHardwareProfile(
      {
        cores: 16,
        totalMemoryBytes: 64 * 1024 ** 3,
        storageFsyncMs: 1,
        cgroupMemoryLimitBytes: 2 * 1024 ** 3,
      },
      {}
    );
    expect(profile).toMatchObject({
      class: "constrained",
      cgroupLimitedMemory: true,
      cgroupLimitedCpu: false,
    });
    expect(profile.budget.memoryCapMb).toBe(
      Math.round(((2 * 1024 ** 3) / 1024 ** 2) * 0.5)
    );
  });

  test("high CPU steal biases an otherwise-large host to constrained without trading durability", () => {
    const profile = resolveGatewayHardwareProfile(
      {
        cores: 16,
        totalMemoryBytes: 64 * 1024 ** 3,
        storageFsyncMs: 1,
        stealPercent: 15,
      },
      {}
    );
    expect(profile).toMatchObject({
      class: "constrained",
      stealPercent: 15,
      workerMaxConcurrent: 2,
      sqliteSynchronous: "FULL",
    });
  });

  test("steal below the threshold is a no-op on class", () => {
    const profile = resolveGatewayHardwareProfile(
      {
        cores: 16,
        totalMemoryBytes: 64 * 1024 ** 3,
        storageFsyncMs: 1,
        stealPercent: 9,
      },
      {}
    );
    expect(profile).toMatchObject({
      class: "standard",
      stealPercent: 9,
      workerMaxConcurrent: 8,
    });
  });

  test("absent cgroup/steal inputs resolve to the plain-host baseline", () => {
    const withNulls = resolveGatewayHardwareProfile(
      {
        cores: 8,
        totalMemoryBytes: 16 * 1024 ** 3,
        storageFsyncMs: 1,
        cgroupCpuLimit: null,
        cgroupMemoryLimitBytes: null,
        stealPercent: null,
      },
      {}
    );
    const baseline = resolveGatewayHardwareProfile(
      { cores: 8, totalMemoryBytes: 16 * 1024 ** 3, storageFsyncMs: 1 },
      {}
    );
    expect(withNulls).toStrictEqual(baseline);
    expect(withNulls).toMatchObject({
      class: "standard",
      cgroupLimitedCpu: false,
      cgroupLimitedMemory: false,
      stealPercent: null,
    });
  });

  test("env overrides still win with clamps under a cgroup-constrained host", () => {
    const profile = resolveGatewayHardwareProfile(
      {
        cores: 16,
        totalMemoryBytes: 64 * 1024 ** 3,
        storageFsyncMs: 1,
        cgroupCpuLimit: 2,
      },
      { CENTRAID_WORKER_MAX_CONCURRENT: "6" }
    );
    expect(profile.workerMaxConcurrent).toBe(6);
  });

  test("a high-steal host in auto mode never trades down durability", () => {
    const profile = resolveGatewayHardwareProfile(
      {
        cores: 16,
        totalMemoryBytes: 64 * 1024 ** 3,
        storageFsyncMs: 1,
        stealPercent: 40,
      },
      {}
    );
    expect(profile.sqliteSynchronous).toBe("FULL");
  });
});
