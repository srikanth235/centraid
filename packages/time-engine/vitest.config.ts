import { nodeProject } from "@centraid/test-kit/vitest";

export default nodeProject({
  test: {
    name: "@centraid/time-engine",
    include: ["src/**/*.test.ts"],
  },
});
