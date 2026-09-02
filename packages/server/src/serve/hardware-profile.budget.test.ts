import { describe, expect, test } from "vitest";

import { resolveGatewayHardwareProfile } from "./hardware-profile.js";
import type { ResourceMode } from "./hardware-profile.js";

/*
 * #528 Phase E ground-truth guard: this table must stay byte-identical on
 * plain hosts (no cgroup limit, no steal) — only cgroup/steal-constrained
 * hosts (hardware-profile.test.ts) may resolve to smaller knobs.
 */

interface ResolvedKnobs {
  class: "constrained" | "standard";
  sqliteSynchronous: "FULL" | "NORMAL";
  workerMaxConcurrent: number;
  workerMaxOldGenerationMb: number;
  workerPoolSize: number;
  replicationConcurrency: number;
  vaultSweepIntervalMs: number;
  outboxIdleIntervalMs: number;
}

const HOSTS: Record<
  string,
  { cores: number; totalMemoryBytes: number; storageFsyncMs?: number }
> = {
  "2c/4GB": { cores: 2, totalMemoryBytes: 4 * 1024 ** 3 },
  "4c/8GB": { cores: 4, totalMemoryBytes: 8 * 1024 ** 3 },
  "8c/16GB": { cores: 8, totalMemoryBytes: 16 * 1024 ** 3 },
  "16c/64GB": { cores: 16, totalMemoryBytes: 64 * 1024 ** 3 },
  "8c/16GB@12ms": {
    cores: 8,
    totalMemoryBytes: 16 * 1024 ** 3,
    storageFsyncMs: 12,
  },
};

const CONSERVE: Omit<ResolvedKnobs, "class" | "sqliteSynchronous"> = {
  workerMaxConcurrent: 2,
  workerMaxOldGenerationMb: 128,
  workerPoolSize: 0,
  replicationConcurrency: 1,
  vaultSweepIntervalMs: 7_200_000,
  outboxIdleIntervalMs: 120_000,
};
const BALANCED: Omit<ResolvedKnobs, "class" | "sqliteSynchronous"> = {
  workerMaxConcurrent: 8,
  workerMaxOldGenerationMb: 256,
  workerPoolSize: 2,
  replicationConcurrency: 3,
  vaultSweepIntervalMs: 3_600_000,
  outboxIdleIntervalMs: 60_000,
};
const PERFORMANCE: Omit<ResolvedKnobs, "class" | "sqliteSynchronous"> = {
  workerMaxConcurrent: 12,
  workerMaxOldGenerationMb: 384,
  workerPoolSize: 4,
  replicationConcurrency: 4,
  vaultSweepIntervalMs: 3_600_000,
  outboxIdleIntervalMs: 60_000,
};

// class per (host, mode): constrained hosts stay constrained under auto;
// conserve pins constrained; balanced/performance pin standard.
const constrainedHost = (host: string): boolean =>
  host === "2c/4GB" || host === "4c/8GB" || host === "8c/16GB@12ms";

const SNAPSHOT: Record<string, ResolvedKnobs> = {};
for (const host of Object.keys(HOSTS)) {
  const modes: ResourceMode[] = ["auto", "conserve", "balanced", "performance"];
  for (const mode of modes) {
    const cls =
      mode === "conserve"
        ? "constrained"
        : mode === "balanced" || mode === "performance"
          ? "standard"
          : constrainedHost(host)
            ? "constrained"
            : "standard";
    const knobs =
      cls === "constrained"
        ? CONSERVE
        : mode === "performance"
          ? PERFORMANCE
          : BALANCED;
    // NORMAL durability only on the owner's explicit Conserve choice.
    const sqliteSynchronous = mode === "conserve" ? "NORMAL" : "FULL";
    SNAPSHOT[`${host} | ${mode}`] = { class: cls, sqliteSynchronous, ...knobs };
  }
}

describe("hardware-profile.budget", () => {
  test.each(Object.entries(SNAPSHOT))(
    "resolved knobs unchanged for %s",
    (label, expected) => {
      const [host, mode] = label.split(" | ") as [string, ResourceMode];
      const profile = resolveGatewayHardwareProfile(
        { ...HOSTS[host], resourceMode: mode },
        {}
      );
      expect({
        class: profile.class,
        sqliteSynchronous: profile.sqliteSynchronous,
        workerMaxConcurrent: profile.workerMaxConcurrent,
        workerMaxOldGenerationMb: profile.workerMaxOldGenerationMb,
        workerPoolSize: profile.workerPoolSize,
        replicationConcurrency: profile.replicationConcurrency,
        vaultSweepIntervalMs: profile.vaultSweepIntervalMs,
        outboxIdleIntervalMs: profile.outboxIdleIntervalMs,
      }).toStrictEqual(expected);
    }
  );
});
