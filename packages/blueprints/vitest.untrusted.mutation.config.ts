import { defineConfig } from "vitest/config";

/**
 * Standalone Stryker test root for the shared untrusted-rendering boundary.
 *
 * `environment: "node"` is load-bearing: the property suite carries NO
 * `@vitest-environment jsdom` docblock, precisely so Stryker's vitest runner
 * measures it instead of dry-running the project as "No tests were executed".
 *
 * NO `@centraid/design` SOURCE ALIAS HERE, unlike vitest.config.ts. Stryker
 * runs this config from a sandbox copy under `.stryker-tmp/`, where a
 * `../design/src/...` replacement resolves to a path that does not exist and
 * the import dies as "Cannot find package" — which Stryker reports as the
 * unrelated "No tests were executed". `untrusted.ts` imports nothing from the
 * design package, so no alias is needed at all.
 */
export default defineConfig({
  test: {
    name: "@centraid/blueprints/untrusted-mutation",
    environment: "node",
    pool: "forks",
    include: ["apps/_shared/untrusted-properties.test.ts"],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
