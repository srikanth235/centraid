import { nodeProject } from "@centraid/test-kit/vitest";

// Project config for @centraid/server. Coverage + the unified run live in the root.
export default nodeProject({
  test: {
    name: "@centraid/server",
    include: ["src/**/*.test.ts", "scripts/check-import-boundary.test.ts"],
    // Gateway files bootstrap real SQLite vaults and bundled apps. Letting all
    // eight host cores start those fixtures at once pushed otherwise healthy
    // beforeEach hooks past the shared 30 s I/O budget during check:pr (the
    // same suites passed when isolated). Four workers keep the request-path
    // coverage parallel without turning fixture setup into disk contention.
    maxWorkers: 4,
    // Unified coverage combines this project with projects that keep Vitest's
    // default worker count. A distinct group is required for that mix and also
    // prevents their fixture pools from competing with the gateway's pool.
    sequence: { groupOrder: 1 },
  },
});
