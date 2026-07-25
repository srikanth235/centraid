/**
 * Compatibility name for the single vault cursor scheduler (issue #541).
 * Existing hosts construct `InProcessScheduler`; all trigger work now runs
 * inside `VaultCursorEngine`.
 */
export {
  VaultCursorEngine as InProcessScheduler,
  type VaultCursorEngineOptions as InProcessSchedulerOptions,
  type LocalCursorScheduler as LocalScheduler,
} from './cursor-engine.js';
