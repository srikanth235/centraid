import { nodeProject } from "@centraid/test-kit/vitest";

export default nodeProject({
  test: {
    name: "@centraid/server",
    include: ["src/**/*.test.ts", "scripts/check-import-boundary.test.ts"],
    maxWorkers: 4,
    sequence: { groupOrder: 1 },
  },
});
