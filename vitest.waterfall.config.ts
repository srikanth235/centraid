import { defineConfig } from "vitest/config";

/**
 * The rung-0 developer command's runner (#927). One file, one gateway, eight
 * apps; `bun run perf:waterfall`. It is a vitest project only because the
 * golden year-3 fixture's generator ships as TypeScript sources.
 */
export default defineConfig({
  test: {
    name: "waterfall",
    include: ["scripts/perf/app-waterfall.run.ts"],
    environment: "node",
    pool: "forks",
    testTimeout: 120_000,
  },
});
