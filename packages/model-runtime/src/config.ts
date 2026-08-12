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
export const RUNTIME_DIR = process.env.CENTRAID_AUTOMATION_RUNTIME_DIR
  ? path.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR)
  : path.join(packageDir, "runtime");
export const MODELS_DIR = path.join(RUNTIME_DIR, "models");
