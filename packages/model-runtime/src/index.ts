// Public entry for @centraid/model-runtime. Everything else in this package
// is either build-time (the automation handler bundles) or loaded by a
// generated handler from its own bundle — the only thing a host needs is the
// model manifest and the one path that provisions it (#1011).
export {
  ensureModelAssets,
  lockCapabilities,
  readModelLock,
  verifyModelAssets,
} from "./model-assets.js";
export type {
  EnsureModelAssetsOptions,
  EnsureModelAssetsResult,
  ModelLock,
  ModelLockFile,
} from "./model-assets.js";
export { MODELS_DIR, RUNTIME_DIR } from "./config.js";
// The system handlers' own model ids, so the host provisions weights for what
// the handlers actually declare rather than for a second list (#1011).
export { FACES_MODEL_ID, OCR_MODEL_ID } from "./model-ids.js";
export type { ModelId } from "./types.js";
