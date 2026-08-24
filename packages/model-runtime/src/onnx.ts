import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { RUNTIME_DIR } from "./config.js";

// WHY this indirection instead of `import "onnxruntime-node"` at the top of
// the file: onnxruntime-node is NOT a dependency of this workspace package
// (see runtime/package.json and the file header there) — it is installed
// only into packages/model-runtime/runtime/node_modules by `bun run
// setup`. A static import would make onnxruntime-node resolvable from this
// package's own module graph, which defeats the entire point of the split
// (a root `bun install` must never need it). Every capability module goes
// through loadOnnxRuntime() below instead, and the failure mode when setup
// hasn't run yet is a clear, actionable error rather than a module-not-found
// stack trace pointing at node_modules internals.
//
// WHY the entry resolution below is written out by hand rather than handed to
// `createRequire`: `node:module` is refused by every sandbox lane in
// packages/server/src/engine/sandbox/policy.ts, and for a good reason — a
// `createRequire` handed to the graph resolves modules through Node's own
// loader, skipping the lane's hooks entirely, so one builtin re-opens
// everything the lane closed. A file that needs it cannot run under ANY lane,
// and an automation worker that loads a recognition bundle must (#846).
// Resolution is the only thing `createRequire` would do here; the LOADING is
// already a plain dynamic `import()` of an absolute file URL, which the
// lane's hooks do see.
//
// What is re-implemented is deliberately the narrow part of Node's algorithm
// the four packages `runtime/` installs actually need — a directory under
// `runtime/node_modules`, then `exports["."]`, then `main`, then `index.js`.
// No `node_modules` walk up the tree (the runtime dir is flat and installed by
// `bun run setup`), no conditional-export matrix beyond require/node/default.
// `resolveRuntimeEntry` is exported so its behaviour is pinned by tests
// against real package.json shapes rather than trusted by inspection.

export type OrtModule = typeof import("onnxruntime-node");

let cachedOrt: OrtModule | undefined;

export class RuntimeNotInstalledError extends Error {
  constructor(specifier: string, cause?: unknown) {
    super(
      `Automation model runtime dependency "${specifier}" is not installed. ` +
        `Run "bun run --cwd packages/model-runtime setup" first — it installs ` +
        `optional native recognition dependencies into packages/model-runtime/runtime/ and ` +
        "downloads the model weights those capabilities need.",
      { cause }
    );
    this.name = "RuntimeNotInstalledError";
  }
}

/**
 * Resolves a package by name from packages/model-runtime/runtime/, the
 * non-workspace directory `bun run setup` installs into. Throws
 * RuntimeNotInstalledError (with a "run setup first" message) when the
 * runtime dependency tree or the named package isn't there yet.
 */
export function resolveRuntimeModule(
  specifier: string,
  runtimeDir: string = RUNTIME_DIR
): string {
  const modulesDir = path.join(runtimeDir, "node_modules");
  if (!existsSync(modulesDir)) {
    throw new RuntimeNotInstalledError(specifier);
  }
  // Scoped names (`@ffmpeg-installer/ffmpeg`) are two path segments; the split
  // is on "/" rather than the platform separator because a bare specifier is
  // always POSIX-shaped.
  const packageDir = path.join(modulesDir, ...specifier.split("/"));
  try {
    const entry = resolveRuntimeEntry(packageDir);
    if (entry === null) throw new Error(`no entry point in ${packageDir}`);
    return entry;
  } catch (error) {
    throw new RuntimeNotInstalledError(specifier, error);
  }
}

/**
 * The absolute entry file of an installed package directory, or `null` when
 * the directory holds no resolvable entry.
 *
 * Precedence mirrors Node's: `exports["."]` wins when present (walking the
 * `require` / `node` / `default` conditions, which is what a CommonJS native
 * package publishes), then `main`, then `index.js`. A `main` that names a
 * directory falls back to `index.js` inside it, as Node does. Every candidate
 * is checked on disk, so a package.json that points at a file the install did
 * not produce is a miss here rather than a module-not-found deeper in.
 */
export function resolveRuntimeEntry(
  packageDir: string,
  depth = 0
): string | null {
  const manifestFile = path.join(packageDir, "package.json");
  const manifest = existsSync(manifestFile)
    ? (JSON.parse(readFileSync(manifestFile, "utf8")) as {
        exports?: unknown;
        main?: unknown;
      })
    : {};
  const candidates = [
    ...conditionalTargets(readDotExport(manifest.exports)),
    ...(typeof manifest.main === "string" ? [manifest.main] : []),
    "index.js",
  ];
  for (const candidate of candidates) {
    const hit = resolveFileTarget(path.resolve(packageDir, candidate), depth);
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * One candidate path to the file it names, or `null` when it names nothing
 * loadable. Three Node behaviours, in Node's order:
 *
 *  - a FILE is itself;
 *  - a DIRECTORY resolves through its own `package.json`, then its `index.js`
 *    — so `"main": "./lib"` works whether `lib/` carries a manifest or just an
 *    index. Bounded, because a manifest can point at another directory;
 *  - an EXTENSIONLESS path gets CommonJS's extension search, so
 *    `"main": "./lib/index"` finds `lib/index.js`.
 */
function resolveFileTarget(target: string, depth: number): string | null {
  const found = statOrNull(target);
  if (found?.isFile()) return target;
  if (found?.isDirectory())
    return depth >= 4 ? null : resolveRuntimeEntry(target, depth + 1);
  for (const extension of [".js", ".json", ".node"]) {
    const withExtension = `${target}${extension}`;
    if (statOrNull(withExtension)?.isFile()) return withExtension;
  }
  return null;
}

function statOrNull(target: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(target);
  } catch {
    return null;
  }
}

/** The `.` subpath of an `exports` field, in either of its two spellings. */
function readDotExport(exportsField: unknown): unknown {
  if (typeof exportsField === "string") return exportsField;
  if (exportsField === null || typeof exportsField !== "object")
    return undefined;
  const record = exportsField as Record<string, unknown>;
  // A bare condition map (`{ require: …, default: … }`) is itself the `.`
  // target; a subpath map names it explicitly.
  return "." in record ? record["."] : record;
}

/**
 * Flatten a conditional-export target to the file paths worth trying, in
 * preference order. Only the conditions this loader can honestly claim are
 * walked — it loads through `import()`, but every package in `runtime/` is
 * CommonJS, so `require` is the truthful condition and `node`/`default` are
 * the fallbacks. Anything else (`browser`, `types`) is skipped rather than
 * guessed at.
 */
function conditionalTargets(target: unknown, depth = 0): string[] {
  if (typeof target === "string") return [target];
  if (depth > 8 || target === null || typeof target !== "object") return [];
  if (Array.isArray(target))
    return target.flatMap((entry) => conditionalTargets(entry, depth + 1));
  const record = target as Record<string, unknown>;
  const out: string[] = [];
  for (const condition of ["require", "node", "default"]) {
    if (condition in record)
      out.push(...conditionalTargets(record[condition], depth + 1));
  }
  return out;
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
