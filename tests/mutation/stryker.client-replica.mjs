/**
 * Root-pointer config for docs / discoverability (#532).
 * Nightly executes `packages/client/stryker.config.mjs` via scripts/mutation/run.mjs.
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export { default } from '../../packages/client/stryker.config.mjs';
