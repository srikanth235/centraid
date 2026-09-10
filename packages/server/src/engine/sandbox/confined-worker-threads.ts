/**
 * The module the sandbox substitutes for `node:worker_threads` inside a lane
 * that runs a NATIVE runtime (#1014, R9).
 *
 * `worker_threads` is on the floor's deliberately-absent list for a real
 * reason: `new Worker(...)` starts a thread on which `module.registerHooks`
 * has never run, so a lane that could construct one could step straight out of
 * its own containment. That reason is about SPAWNING.
 *
 * It is not about `isMainThread`. `onnxruntime-node@1.27`'s `dist/binding.js`
 * reads exactly that one boolean at load and hands it to `initOrtOnce`, so a
 * bundled-optional recogniser on the `model-runtime` lane — `embed-text`,
 * `embed-image` — refused to load at all: "builtin node:worker_threads is not
 * in lane model-runtime's allowlist", on first-party code the release ships.
 *
 * So this is the same answer `confined-fs` gives: a PARTIAL mirror, fail-closed
 * by omission. Two facts about the thread the caller is already on, and no
 * constructor. `Worker`, `parentPort`, `workerData`, `MessageChannel` and
 * `receiveMessageOnPort` are absent — a graph that reaches for one gets
 * `undefined` and fails at the call site, which is the containment property
 * intact. Widening this file is widening the lane.
 */

export { isMainThread, threadId } from "node:worker_threads";
