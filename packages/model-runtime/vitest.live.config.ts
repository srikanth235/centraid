import { nodeProject } from "@centraid/test-kit/vitest";

export default nodeProject({
  test: {
    name: "@centraid/model-runtime-live",
    include: ["src/**/*.live.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
  },
});
