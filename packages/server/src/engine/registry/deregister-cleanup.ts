import { promises as fs } from "node:fs";
import path from "node:path";

import type { RegistryEntry } from "../types.js";

export interface DeregisterLogger {
  warn: (message: string) => void;
}

export type CleanupOutcome =
  | { kind: "removed" }
  | { kind: "skipped"; reason: "outside-appsdir" }
  | { kind: "failed"; error: Error };

export async function cleanupDeregisteredApp(
  appsDir: string,
  entry: RegistryEntry,
  logger: DeregisterLogger
): Promise<CleanupOutcome> {
  const rel = path.relative(appsDir, entry.path);
  const insideAppsDir =
    !!rel && !rel.startsWith("..") && !path.isAbsolute(rel) && rel.length > 0;
  if (!insideAppsDir) {
    logger.warn(
      `[centraid] deregister: refusing to remove "${entry.path}" — outside appsDir`
    );
    return { kind: "skipped", reason: "outside-appsdir" };
  }
  try {
    await fs.rm(entry.path, { recursive: true, force: true });
    return { kind: "removed" };
  } catch (error) {
    const e = error instanceof Error ? error : new Error(String(error));
    logger.warn(
      `[centraid] deregister: failed to remove "${entry.path}": ${e.message}`
    );
    return { kind: "failed", error: e };
  }
}
