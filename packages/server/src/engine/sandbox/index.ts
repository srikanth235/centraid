/**
 * Handler sandbox — the containment applied to the least-trusted code the
 * product runs: app-handler and automation-handler JavaScript, and the
 * model-runtime graph around ONNX inference.
 *
 * Read `install.ts` before relying on any of this in a threat model: the
 * "what it does not enforce" block there is the load-bearing half.
 */

export {
  installWorkerSandbox,
  resetWorkerSandboxForTests,
  SandboxDenied,
} from "./install.js";
export type { SandboxHandle } from "./install.js";
export {
  appHandlerPolicy,
  automationHandlerPolicy,
  builtinDecision,
  builtinId,
  COMPUTATIONAL_BUILTINS,
  isPathWithinRoots,
  modelRuntimePolicy,
  normalizeRoots,
} from "./policy.js";
export type {
  BuiltinDecision,
  FilesystemGrant,
  SandboxLane,
  SandboxPolicy,
} from "./policy.js";
export {
  confinedReadRoots,
  SandboxFilesystemDenied,
  SandboxWriteDenied,
  setConfinedReadRoots,
} from "./confined-fs.js";
