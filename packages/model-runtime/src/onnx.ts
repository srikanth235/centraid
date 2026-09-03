import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { RUNTIME_DIR } from "./config.js";

// WHY NOT A STATIC `import "onnxruntime-node"`.
// Setup installs it into `runtime/node_modules` alone, and a root `bun install`
// must never need it.
//
// WHY RESOLUTION IS HAND-WRITTEN, NOT `createRequire`.
// Every sandbox lane refuses `node:module`, and an automation worker loading a
// recognition bundle must run under a lane (#846).

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

export function resolveRuntimeModule(
  specifier: string,
  runtimeDir: string = RUNTIME_DIR
): string {
  const modulesDir = path.join(runtimeDir, "node_modules");
  if (!existsSync(modulesDir)) {
    throw new RuntimeNotInstalledError(specifier);
  }
  // Split on "/", never the platform separator: specifiers are POSIX.
  const packageDir = path.join(modulesDir, ...specifier.split("/"));
  try {
    const entry = resolveRuntimeEntry(packageDir);
    if (entry === null) throw new Error(`no entry point in ${packageDir}`);
    return entry;
  } catch (error) {
    throw new RuntimeNotInstalledError(specifier, error);
  }
}

/** Node's precedence, checked on disk: a bad manifest misses here, not deeper
 *  in. */
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

/** Bounded: a directory's manifest can name another directory. */
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

function readDotExport(exportsField: unknown): unknown {
  if (typeof exportsField === "string") return exportsField;
  if (exportsField === null || typeof exportsField !== "object")
    return undefined;
  const record = exportsField as Record<string, unknown>;
  return "." in record ? record["."] : record;
}

/** `runtime/` is all CommonJS, so `require` is the truthful condition; others
 *  are skipped, never guessed at. */
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

export async function loadOnnxRuntime(): Promise<OrtModule> {
  if (cachedOrt) {
    return cachedOrt;
  }
  const resolved = resolveRuntimeModule("onnxruntime-node");
  const mod = (await import(pathToFileURL(resolved).href)) as OrtModule;
  cachedOrt = mod;
  return cachedOrt;
}

/** Test-only seam. @public */
export function resetOnnxRuntimeCacheForTests(): void {
  cachedOrt = undefined;
}

let cachedSessions:
  | Map<string, Promise<InstanceType<OrtModule["InferenceSession"]>>>
  | undefined;

/** One session per path: capability modules never construct their own. */
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
