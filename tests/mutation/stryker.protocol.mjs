/**
 * Root-pointer config for docs / discoverability (#532).
 * Nightly executes `packages/core/stryker.protocol.config.mjs` via scripts/mutation/run.mjs.
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export { default } from "../../packages/core/stryker.protocol.config.mjs";
