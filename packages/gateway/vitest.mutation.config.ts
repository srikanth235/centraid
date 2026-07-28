import { defineConfig } from "vitest/config";

/** Standalone Stryker test root for gateway allowlist helpers. */
export default defineConfig({
  test: {
    name: "@centraid/gateway-mutation",
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
