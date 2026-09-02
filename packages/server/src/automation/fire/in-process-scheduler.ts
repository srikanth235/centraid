// Compatibility name for the single vault cursor scheduler (#541); all trigger
// work runs inside `VaultCursorEngine`.
export {
  VaultCursorEngine as InProcessScheduler,
  type VaultCursorEngineOptions as InProcessSchedulerOptions,
  type LocalCursorScheduler as LocalScheduler,
} from "./cursor-engine.js";
