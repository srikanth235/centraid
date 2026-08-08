import { nodeProject } from "@centraid/test-kit/vitest";

/** Real-weight evidence lane; setup must have populated runtime/ first. */
export default nodeProject({
  test: {
    name: "@centraid/enrichment-service-live",
    include: ["src/**/*.live.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
  },
});
