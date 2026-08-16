import { nodeProject } from "@centraid/test-kit/vitest";

export default nodeProject({
  test: {
    name: "@centraid/core",
    include: ["src/**/*.test.ts", "zero-dep-guard.test.ts"],
  },
});
