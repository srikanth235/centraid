import { describe, expect, test } from "vitest";

import {
  formatHardwareProfileDetail,
  hardwareClassForResourceMode,
  RESOURCE_KNOB_BOUNDS,
  resolveGatewayHardwareProfile,
  toStructuredResourceProfile,
} from "./hardware-profile.js";
import type {
  ResourceKnobName,
  ResourceKnobSource,
} from "./hardware-profile.js";

const ALL_PRESET_SOURCES: Record<ResourceKnobName, ResourceKnobSource> = {
  workerMaxConcurrent: { source: "preset" },
  workerMaxOldGenerationMb: { source: "preset" },
  workerPoolSize: { source: "preset" },
  replicationConcurrency: { source: "preset" },
};

describe("hardware-profile", () => {
  test("slow storage selects one coherent constrained-host profile", () => {
    expect(
      resolveGatewayHardwareProfile(
        { cores: 8, totalMemoryBytes: 16 * 1024 ** 3, storageFsyncMs: 20 },
        {}
      )
    ).toMatchObject({
      class: "constrained",
      resourceMode: "auto",
      sqliteSynchronous: "FULL",
      workerMaxConcurrent: 2,
      workerMaxOldGenerationMb: 128,
      workerPoolSize: 0,
      replicationConcurrency: 1,
      vaultMountStrategy: "eager",
      vaultSweepIntervalMs: 7_200_000,
      outboxIdleIntervalMs: 120_000,
    });
  });

  test("only an explicitly selected constrained profile opts into NORMAL", () => {
    expect(
      resolveGatewayHardwareProfile(
        { cores: 8, totalMemoryBytes: 16 * 1024 ** 3, storageFsyncMs: 1 },
        { CENTRAID_HARDWARE_PROFILE: "constrained" }
      )
    ).toMatchObject({ class: "constrained", sqliteSynchronous: "NORMAL" });
  });

  test("explicit profile and durability overrides win over detection", () => {
    expect(
      resolveGatewayHardwareProfile(
        { cores: 2, totalMemoryBytes: 1024 ** 3, storageFsyncMs: 30 },
        {
          CENTRAID_HARDWARE_PROFILE: "standard",
          CENTRAID_SQLITE_SYNCHRONOUS: "NORMAL",
        }
      )
    ).toMatchObject({
      class: "standard",
      sqliteSynchronous: "NORMAL",
      workerPoolSize: 2,
      vaultMountStrategy: "eager",
      vaultSweepIntervalMs: 3_600_000,
      outboxIdleIntervalMs: 60_000,
    });
  });

  test("explicit tuning overrides are reflected in the resolved profile", () => {
    expect(
      resolveGatewayHardwareProfile(
        { cores: 8, totalMemoryBytes: 16 * 1024 ** 3, storageFsyncMs: 1 },
        {
          CENTRAID_WORKER_MAX_CONCURRENT: "3",
          CENTRAID_WORKER_MAX_OLD_GENERATION_MB: "192",
          CENTRAID_WORKER_POOL_SIZE: "1",
          CENTRAID_REPLICATION_CONCURRENCY: "2",
        }
      )
    ).toMatchObject({
      workerMaxConcurrent: 3,
      workerMaxOldGenerationMb: 192,
      workerPoolSize: 1,
      replicationConcurrency: 2,
    });
  });

  test("Conserve mode pins constrained limits and NORMAL durability", () => {
    const profile = resolveGatewayHardwareProfile(
      {
        cores: 16,
        totalMemoryBytes: 32 * 1024 ** 3,
        storageFsyncMs: 1,
        resourceMode: "conserve",
      },
      {}
    );
    expect(profile).toMatchObject({
      class: "constrained",
      resourceMode: "conserve",
      sqliteSynchronous: "NORMAL",
      workerMaxConcurrent: 2,
      workerPoolSize: 0,
      replicationConcurrency: 1,
    });
    expect(formatHardwareProfileDetail(profile)).toContain("mode=Conserve");
    expect(formatHardwareProfileDetail(profile)).toContain("class=constrained");
  });

  test("Balanced mode pins standard throughput on a small host", () => {
    expect(
      resolveGatewayHardwareProfile(
        {
          cores: 2,
          totalMemoryBytes: 2 * 1024 ** 3,
          storageFsyncMs: 30,
          resourceMode: "balanced",
        },
        {}
      )
    ).toMatchObject({
      class: "standard",
      resourceMode: "balanced",
      workerMaxConcurrent: 8,
      workerPoolSize: 2,
      replicationConcurrency: 3,
      sqliteSynchronous: "FULL",
    });
  });

  test("Performance mode raises standard-class worker and replication ceilings", () => {
    const performance = resolveGatewayHardwareProfile(
      {
        cores: 8,
        totalMemoryBytes: 16 * 1024 ** 3,
        storageFsyncMs: 1,
        resourceMode: "performance",
      },
      {}
    );
    const balanced = resolveGatewayHardwareProfile(
      {
        cores: 8,
        totalMemoryBytes: 16 * 1024 ** 3,
        storageFsyncMs: 1,
        resourceMode: "balanced",
      },
      {}
    );
    expect(performance.class).toBe("standard");
    expect(performance.workerMaxConcurrent).toBeGreaterThan(
      balanced.workerMaxConcurrent
    );
    expect(performance.workerPoolSize).toBeGreaterThan(balanced.workerPoolSize);
    expect(performance.replicationConcurrency).toBeGreaterThan(
      balanced.replicationConcurrency
    );
  });

  test("CENTRAID_HARDWARE_PROFILE still wins over Resource mode for class", () => {
    expect(
      resolveGatewayHardwareProfile(
        {
          cores: 16,
          totalMemoryBytes: 32 * 1024 ** 3,
          resourceMode: "conserve",
        },
        { CENTRAID_HARDWARE_PROFILE: "standard" }
      )
    ).toMatchObject({ class: "standard", resourceMode: "conserve" });
  });

  test("toStructuredResourceProfile projects a constrained conserve profile", () => {
    const profile = resolveGatewayHardwareProfile(
      {
        cores: 2,
        totalMemoryBytes: 2 * 1024 ** 3,
        storageFsyncMs: 20,
        resourceMode: "conserve",
      },
      {}
    );
    expect(toStructuredResourceProfile(profile)).toStrictEqual({
      class: "constrained",
      mode: "conserve",
      host: {
        cores: 2,
        totalMemoryBytes: 2 * 1024 ** 3,
        storageFsyncMs: 20,
        cgroupLimitedCpu: false,
        cgroupLimitedMemory: false,
        stealPercent: null,
      },
      budget: {
        cpuShare: 0.5,
        memoryCapMb: Math.round(((2 * 1024 ** 3) / 1024 ** 2) * 0.5),
      },
      resolved: {
        workerMaxConcurrent: 2,
        workerMaxOldGenerationMb: 128,
        workerPoolSize: 0,
        replicationConcurrency: 1,
        sqliteSynchronous: "NORMAL",
        vaultSweepIntervalMs: 7_200_000,
        outboxIdleIntervalMs: 120_000,
      },
      sources: ALL_PRESET_SOURCES,
      bounds: RESOURCE_KNOB_BOUNDS,
    });
  });

  test("toStructuredResourceProfile projects a standard performance profile", () => {
    const profile = resolveGatewayHardwareProfile(
      {
        cores: 8,
        totalMemoryBytes: 16 * 1024 ** 3,
        storageFsyncMs: 1,
        resourceMode: "performance",
      },
      {}
    );
    expect(toStructuredResourceProfile(profile)).toStrictEqual({
      class: "standard",
      mode: "performance",
      host: {
        cores: 8,
        totalMemoryBytes: 16 * 1024 ** 3,
        storageFsyncMs: 1,
        cgroupLimitedCpu: false,
        cgroupLimitedMemory: false,
        stealPercent: null,
      },
      budget: {
        cpuShare: 1,
        memoryCapMb: Math.round((16 * 1024 ** 3) / 1024 ** 2),
      },
      resolved: {
        workerMaxConcurrent: 12,
        workerMaxOldGenerationMb: 384,
        workerPoolSize: 4,
        replicationConcurrency: 4,
        sqliteSynchronous: "FULL",
        vaultSweepIntervalMs: 3_600_000,
        outboxIdleIntervalMs: 60_000,
      },
      sources: ALL_PRESET_SOURCES,
      bounds: RESOURCE_KNOB_BOUNDS,
    });
  });

  test("toStructuredResourceProfile carries a null host storageFsyncMs through", () => {
    const profile = resolveGatewayHardwareProfile(
      { cores: 8, totalMemoryBytes: 16 * 1024 ** 3 },
      {}
    );
    expect(toStructuredResourceProfile(profile).host.storageFsyncMs).toBeNull();
  });

  test("budget presets frame conserve/balanced/performance as a share of the granted host", () => {
    const conserve = resolveGatewayHardwareProfile(
      { cores: 2, totalMemoryBytes: 4 * 1024 ** 3, resourceMode: "conserve" },
      {}
    );
    const balanced = resolveGatewayHardwareProfile(
      { cores: 8, totalMemoryBytes: 16 * 1024 ** 3, resourceMode: "balanced" },
      {}
    );
    const performance = resolveGatewayHardwareProfile(
      {
        cores: 8,
        totalMemoryBytes: 16 * 1024 ** 3,
        resourceMode: "performance",
      },
      {}
    );
    expect(conserve.budget.cpuShare).toBe(0.5);
    expect(balanced.budget.cpuShare).toBe(0.75);
    expect(performance.budget.cpuShare).toBe(1);
    expect(performance.budget.memoryCapMb).toBeGreaterThan(
      balanced.budget.memoryCapMb
    );
  });

  test("hardwareClassForResourceMode maps modes without re-detection", () => {
    expect(hardwareClassForResourceMode("auto", "constrained")).toBe(
      "constrained"
    );
    expect(hardwareClassForResourceMode("auto", "standard")).toBe("standard");
    expect(hardwareClassForResourceMode("conserve", "standard")).toBe(
      "constrained"
    );
    expect(hardwareClassForResourceMode("balanced", "constrained")).toBe(
      "standard"
    );
    expect(hardwareClassForResourceMode("performance", "constrained")).toBe(
      "standard"
    );
  });

  const STANDARD_HOST = {
    cores: 8,
    totalMemoryBytes: 16 * 1024 ** 3,
    storageFsyncMs: 1,
  };

  test("a prefs override wins over the preset baseline and is attributed to prefs", () => {
    const profile = resolveGatewayHardwareProfile(
      { ...STANDARD_HOST, prefsOverrides: { workerMaxConcurrent: 5 } },
      {}
    );
    expect(profile.workerMaxConcurrent).toBe(5);
    expect(profile.sources.workerMaxConcurrent).toStrictEqual({
      source: "prefs",
    });
    expect(profile.sources.replicationConcurrency).toStrictEqual({
      source: "preset",
    });
  });

  test("env still wins over a prefs override for the same knob, with the env var named", () => {
    const profile = resolveGatewayHardwareProfile(
      { ...STANDARD_HOST, prefsOverrides: { workerMaxConcurrent: 5 } },
      { CENTRAID_WORKER_MAX_CONCURRENT: "9" }
    );
    expect(profile.workerMaxConcurrent).toBe(9);
    expect(profile.sources.workerMaxConcurrent).toStrictEqual({
      source: "env",
      envVar: "CENTRAID_WORKER_MAX_CONCURRENT",
    });
  });

  test("a prefs override clamps through the same bounds as env", () => {
    const profile = resolveGatewayHardwareProfile(
      {
        ...STANDARD_HOST,
        prefsOverrides: {
          workerMaxConcurrent: 999,
          workerMaxOldGenerationMb: 4,
        },
      },
      {}
    );
    expect(profile.workerMaxConcurrent).toBe(
      RESOURCE_KNOB_BOUNDS.workerMaxConcurrent.max
    );
    expect(profile.sources.workerMaxConcurrent).toStrictEqual({
      source: "prefs",
    });
    expect(profile.workerMaxOldGenerationMb).toBe(256); // balanced preset
    expect(profile.sources.workerMaxOldGenerationMb).toStrictEqual({
      source: "preset",
    });
  });

  test("a prefs override of one knob does not disturb the others' sources", () => {
    const profile = resolveGatewayHardwareProfile(
      { ...STANDARD_HOST, prefsOverrides: { replicationConcurrency: 2 } },
      { CENTRAID_WORKER_POOL_SIZE: "3" }
    );
    expect(profile.sources.replicationConcurrency).toStrictEqual({
      source: "prefs",
    });
    expect(profile.sources.workerPoolSize).toStrictEqual({
      source: "env",
      envVar: "CENTRAID_WORKER_POOL_SIZE",
    });
    expect(profile.sources.workerMaxConcurrent).toStrictEqual({
      source: "preset",
    });
  });

  test("no prefsOverrides yields output identical to omitting the field", () => {
    const withEmpty = resolveGatewayHardwareProfile(
      { ...STANDARD_HOST, prefsOverrides: {} },
      {}
    );
    const without = resolveGatewayHardwareProfile({ ...STANDARD_HOST }, {});
    expect(withEmpty).toStrictEqual(without);
    expect(withEmpty.sources).toStrictEqual(ALL_PRESET_SOURCES);
  });

  test("the structured profile publishes the bounds table for the client", () => {
    const structured = toStructuredResourceProfile(
      resolveGatewayHardwareProfile({ ...STANDARD_HOST }, {})
    );
    expect(structured.bounds).toStrictEqual(RESOURCE_KNOB_BOUNDS);
    expect(structured.bounds.workerPoolSize).toStrictEqual({ min: 0, max: 8 });
  });
});
