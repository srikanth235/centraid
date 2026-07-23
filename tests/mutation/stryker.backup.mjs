/**
 * Root-pointer config for docs / discoverability (#532).
 * Nightly executes `packages/backup/stryker.config.mjs` via scripts/mutation/run.mjs.
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export { default } from '../../packages/backup/stryker.config.mjs';
