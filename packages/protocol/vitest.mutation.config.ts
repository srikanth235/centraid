import { defineConfig } from 'vitest/config';

/** Standalone Stryker test root for protocol (defineConfig, not defineProject). */
export default defineConfig({
  test: {
    name: '@centraid/protocol-mutation',
    environment: 'node',
    pool: 'forks',
    include: ['src/handshake-properties.test.ts', 'src/handshake.test.ts'],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
