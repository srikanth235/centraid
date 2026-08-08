import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { RUNTIME_DIR } from "./config.js";

// WHY this indirection instead of `import "onnxruntime-node"` at the top of
// the file: onnxruntime-node is NOT a dependency of this workspace package
// (see runtime/package.json and the file header there) — it is installed
// only into tools/enrichment-service/runtime/node_modules by `bun run
// setup`. A static import would make onnxruntime-node resolvable from this
// package's own module graph, which defeats the entire point of the split
// (a root `bun install` must never need it). Every capability module goes
// through loadOnnxRuntime() below instead, and the failure mode when setup
// hasn't run yet is a clear, actionable error rather than a module-not-found
// stack trace pointing at node_modules internals.
//
// `createRequire` rooted at runtime/package.json makes Node's own CommonJS
// resolver do the path math (platform-specific native binding selection,
// package.json "main" field, etc.) instead of us guessing onnxruntime-node's
// internal layout by hand.

export type OrtModule = typeof import("onnxruntime-node");

let cachedOrt: OrtModule | undefined;

export class RuntimeNotInstalledError extends Error {
  constructor(specifier: string, cause?: unknown) {
    super(
      `Enrichment service runtime dependency "${specifier}" is not installed. ` +
        `Run "bun run --cwd tools/enrichment-service setup" first — it installs ` +
        `onnxruntime-node and sharp into tools/enrichment-service/runtime/ and ` +
        "downloads the model weights those capabilities need.",
      { cause }
    );
    this.name = "RuntimeNotInstalledError";
  }
}

/**
 * Resolves a package by name from tools/enrichment-service/runtime/, the
 * non-workspace directory `bun run setup` installs into. Throws
 * RuntimeNotInstalledError (with a "run setup first" message) when the
 * runtime dependency tree or the named package isn't there yet.
 */
export function resolveRuntimeModule(
  specifier: string,
  runtimeDir: string = RUNTIME_DIR
): string {
  if (!existsSync(path.join(runtimeDir, "node_modules"))) {
    throw new RuntimeNotInstalledError(specifier);
  }
  const requireFromRuntime = createRequire(
    path.join(runtimeDir, "package.json")
  );
  try {
    return requireFromRuntime.resolve(specifier);
  } catch (error) {
    throw new RuntimeNotInstalledError(specifier, error);
  }
}

/** Lazily imports onnxruntime-node from runtime/node_modules. Cached after first call. */
export async function loadOnnxRuntime(): Promise<OrtModule> {
  if (cachedOrt) {
    return cachedOrt;
  }
  const resolved = resolveRuntimeModule("onnxruntime-node");
  const mod = (await import(pathToFileURL(resolved).href)) as OrtModule;
  cachedOrt = mod;
  return cachedOrt;
}

/** Test-only seam: lets tests observe a clean cache without process isolation. @public */
export function resetOnnxRuntimeCacheForTests(): void {
  cachedOrt = undefined;
}

let cachedSessions:
  | Map<string, Promise<InstanceType<OrtModule["InferenceSession"]>>>
  | undefined;

/**
 * Creates (or returns a cached) InferenceSession for a model file under
 * runtime/models/. One session per absolute path — every capability module
 * calls this rather than constructing sessions itself, so a single warm
 * process never opens the same model twice.
 */
export async function getOrCreateSession(
  modelPath: string
): Promise<InstanceType<OrtModule["InferenceSession"]>> {
  cachedSessions ??= new Map();
  const existing = cachedSessions.get(modelPath);
  if (existing) {
    return existing;
  }
  if (!existsSync(modelPath)) {
    throw new RuntimeNotInstalledError(modelPath);
  }
  const pending = loadOnnxRuntime().then((ort) =>
    ort.InferenceSession.create(modelPath)
  );
  cachedSessions.set(modelPath, pending);
  try {
    return await pending;
  } catch (error) {
    cachedSessions.delete(modelPath);
    throw error;
  }
}

/** Test-only seam. @public */
export function resetSessionCacheForTests(): void {
  cachedSessions = undefined;
}
