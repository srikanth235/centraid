import { defineConfig } from "vitest/config";

/**
 * Standalone Stryker test root for the shared pending-write overlay.
 *
 * NO `@centraid/design` SOURCE ALIAS HERE, unlike vitest.config.ts. Stryker
 * runs this config from a sandbox copy under `.stryker-tmp/`, where a
 * `../design/src/...` replacement resolves to a path that does not exist and
 * the import dies as "Cannot find package" — which Stryker reports as the
 * unrelated "No tests were executed". The bare specifier resolves through
 * node_modules to the package's built `dist`, which is why ci.yml builds
 * `./packages/*` before the mutation lane runs.
 */
export default defineConfig({
  test: {
    name: "@centraid/blueprints/pending-overlay-mutation",
    environment: "node",
    pool: "forks",
    include: [
      "apps/_shared/pending-overlay.test.ts",
      "apps/_shared/pending-overlay-law.test.ts",
    ],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
