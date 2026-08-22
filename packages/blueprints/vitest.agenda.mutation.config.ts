import { defineConfig } from "vitest/config";

/**
 * Standalone Stryker test root for the Agenda app's logic layer.
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
    name: "@centraid/blueprints/agenda-mutation",
    environment: "node",
    pool: "forks",
    include: [
      "apps/agenda/logic.test.ts",
      "apps/agenda/logic-search.test.ts",
      "apps/agenda/edits.test.ts",
      "apps/agenda/views.test.ts",
      "apps/agenda/day-context.test.ts",
      "apps/agenda/view-copy.test.ts",
      "apps/agenda/format-locale.test.ts",
    ],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
