/**
 * Handler sandbox — the containment applied to the least-trusted code the
 * product runs: app-handler and automation-handler JavaScript, and the
 * model-runtime graph around ONNX inference.
 *
 * Read `install.ts` before relying on any of this in a threat model: the
 * "what it does not enforce" block there is the load-bearing half.
 */

export { installWorkerSandbox, resetWorkerSandboxForTests } from "./install.js";
export type { SandboxHandle } from "./install.js";
export {
  denied,
  deniedPath,
  deniedWrite,
  SandboxDeniedError,
} from "./denied.js";
export type { SandboxDeniedCode } from "./denied.js";
export {
  appHandlerPolicy,
  appSeedPolicy,
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
  guardReadPath,
  setConfinedReadRoots,
} from "./fs-guard.js";
/**
 * The confined `node:fs` / `node:fs/promises` mirrors. Nothing imports them by
 * specifier — the loader hook in `install.ts` redirects the untrusted graph's
 * builtin resolution onto their URLs at runtime — so they are re-exported here
 * to keep them reachable from the package's own module graph rather than
 * looking like dead files.
 */
export * as confinedFs from "./confined-fs.js";
export * as confinedFsPromises from "./confined-fs-promises.js";
/** Loaded by the worker runners through an absolute-path dynamic import. */
export { loadSandbox } from "./boot.js";
export type { SandboxBoot } from "./boot.js";
