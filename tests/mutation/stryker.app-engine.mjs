/**
 * Root-pointer config for docs / discoverability (#532).
 * Nightly executes `packages/server/stryker.engine.config.mjs` via scripts/mutation/run.mjs.
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export { default } from "../../packages/server/stryker.engine.config.mjs";
