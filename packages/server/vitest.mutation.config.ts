import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@centraid/server-mutation",
    environment: "node",
    pool: "forks",
    include: [
      "src/cli/allowed-hosts.test.ts",
      "src/cli/allowed-hosts-properties.test.ts",
    ],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
