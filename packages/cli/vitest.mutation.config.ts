import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@centraid/cli-mutation",
    environment: "node",
    pool: "forks",
    include: [
      "src/auth.test.ts",
      "src/auth.precedence.test.ts",
      "src/cli.branches.test.ts",
      "src/cli.contract.test.ts",
    ],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
