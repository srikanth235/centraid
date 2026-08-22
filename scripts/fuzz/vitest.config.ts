import { defineConfig } from "vitest/config";

/**
 * Fuzz crasher replay lane (#839 G10).
 *
 * Its own project because it is the only vitest surface that imports both a
 * package's built `dist` and `packages/client`'s TypeScript source in the same
 * process, and because it must stay runnable on the PR path independently of
 * the nightly fuzz job — a crasher that has been found and characterised must
 * never come back unnoticed.
 */
export default defineConfig({
  test: {
    name: "fuzz-replay",
    include: ["scripts/fuzz/**/*.test.mjs"],
    environment: "node",
    pool: "forks",
    expect: { requireAssertions: true },
  },
});
