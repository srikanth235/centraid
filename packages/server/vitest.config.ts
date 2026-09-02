import { nodeProject } from "@centraid/test-kit/vitest";

export default nodeProject({
  test: {
    name: "@centraid/server",
    include: ["src/**/*.test.ts", "scripts/check-import-boundary.test.ts"],
    // More workers push real-SQLite beforeEach fixtures past the shared 30 s I/O budget in check:pr.
    maxWorkers: 4,
    // Unified coverage mixes this project (worker-capped) with default-worker projects; the group keeps their fixture pools apart.
    sequence: { groupOrder: 1 },
  },
});
