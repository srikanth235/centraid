import path from "node:path";

// Every path in this file is resolved from THIS file's location rather than
// process.cwd(), so setup, live tests, and the bundled handler build resolve
// the same runtime/ directory regardless of their caller's working directory.
const packageDir = path.resolve(import.meta.dirname, "..");

/**
 * Native libraries and immutable model weights used by bundled automation
 * handlers. The override is an asset-location concern only: no process listens
 * here and no inference request crosses a service boundary. A generated
 * handler resolves the same directory when it runs from a vault code store.
 */
/**
 * Host-planted runtime directory, read BEFORE the environment (#846 P9).
 *
 * A sandboxed automation handler has no `process.env` — every lane replaces it
 * with a frozen empty object — so the override below is unreadable from inside
 * one. The host therefore resolves it and plants the answer on `globalThis`
 * before the handler's module graph loads. This is a PATH, not a capability:
 * the sandbox exists to deny ambient authority, and telling a handler where
 * its own weights live grants none. `packages/server/src/automation/worker/
 * runner.ts` is the only writer.
 */
const HOST_RUNTIME_DIR = "__centraidAutomationRuntimeDir";

function resolveRuntimeDir(): string {
  const planted = (globalThis as Record<string, unknown>)[HOST_RUNTIME_DIR];
  if (typeof planted === "string" && planted.length > 0)
    return path.resolve(planted);
  // Unsandboxed callers — `setup`, the live-model lane, the bundle build.
  if (process.env?.CENTRAID_AUTOMATION_RUNTIME_DIR)
    return path.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR);
  return path.join(packageDir, "runtime");
}

export const RUNTIME_DIR = resolveRuntimeDir();
export const MODELS_DIR = path.join(RUNTIME_DIR, "models");
