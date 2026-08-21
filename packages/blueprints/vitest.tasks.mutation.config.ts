import { defineConfig } from "vitest/config";

/**
 * Standalone Stryker test root for the Tasks board's pure derivations.
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
    name: "@centraid/blueprints/tasks-mutation",
    environment: "node",
    pool: "forks",
    include: [
      "apps/tasks/logic.test.ts",
      "apps/tasks/format.test.ts",
      "apps/tasks/routes.test.ts",
      "apps/tasks/view-copy.test.ts",
    ],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
