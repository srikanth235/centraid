import path from "node:path";

const packageDir = path.resolve(import.meta.dirname, "..");

const HOST_RUNTIME_DIR = "__centraidAutomationRuntimeDir";

function resolveRuntimeDir(): string {
  const planted = (globalThis as Record<string, unknown>)[HOST_RUNTIME_DIR];
  if (typeof planted === "string" && planted.length > 0)
    return path.resolve(planted);
  if (process.env?.CENTRAID_AUTOMATION_RUNTIME_DIR)
    return path.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR);
  return path.join(packageDir, "runtime");
}

export const RUNTIME_DIR = resolveRuntimeDir();
export const MODELS_DIR = path.join(RUNTIME_DIR, "models");
