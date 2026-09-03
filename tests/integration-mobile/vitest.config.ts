import { nodeProject } from "@centraid/test-kit/vitest";

export default nodeProject({
  root: import.meta.dirname,
  test: {
    name: "@centraid/mobile-integration",
    include: ["**/*.integration.test.ts"],
    fileParallelism: false,
  },
});
