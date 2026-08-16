import { defineConfig } from "vitest/config";

/** Standalone Stryker test root for protocol handshake laws. */
export default defineConfig({
  test: {
    name: "@centraid/core/protocol-mutation",
    environment: "node",
    pool: "forks",
    include: [
      "src/protocol/handshake-properties.test.ts",
      "src/protocol/handshake.test.ts",
    ],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
