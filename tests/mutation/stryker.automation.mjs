/**
 * Root-pointer config for docs / discoverability (#532).
 * Nightly executes `packages/automation/stryker.config.mjs` via scripts/mutation/run.mjs.
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export { default } from '../../packages/automation/stryker.config.mjs';
