/*
 * The nightly perf lane. `fileParallelism: false` is GONE (#927).
 *
 * It existed because these rigs gated on wall clock, and a wall clock is only
 * meaningful when nothing else on the host competes for the cores. The gate is
 * now the paired candidate/PR run (scripts/ci/paired-journeys.mjs), which
 * measures BOTH trees under whatever contention the runner has and compares the
 * paired difference — so serialising the whole lane bought nothing for the gate
 * that matters and cost the lane its own duration.
 *
 * What the removal actually costs, measured on this container (4 cores /
 * 15 GB): the gateway cold-start rig read 5,291 ms serially and 6,250 ms in
 * parallel. Its 5,000 ms ceiling was already breached SERIALLY, so the ceiling
 * is seeded from a faster host than CI runs on — that is a finding about the
 * ceiling, not an argument for the flag.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "nightly-perf",
    include: ["tests/perf/**/*.perf.test.ts"],
    environment: "node",
    pool: "forks",
    testTimeout: 60_000,
  },
});
