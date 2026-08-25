/*
 * One platform default for every gateway owner (#555). Desktop,
 * service units, and the CLI use this resolver instead of inventing roots
 * under a client application's userData directory.
 */

import os from "node:os";
import path from "node:path";

/** Stable loopback port used by daemon-owned possession-plane CLI verbs. */
export const DEFAULT_GATEWAY_PORT = 17_832;

export interface DefaultDataDirOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

export function platformDefaultDataDir(
  options: DefaultDataDirOptions = {}
): string {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const env = options.env ?? process.env;
  if (platform === "darwin") {
    return path.join(
      homeDir,
      "Library",
      "Application Support",
      "centraid",
      "gateway"
    );
  }
  if (platform === "win32") {
    const local =
      env.LOCALAPPDATA?.trim() || path.join(homeDir, "AppData", "Local");
    return path.join(local, "Centraid", "gateway");
  }
  const dataHome =
    env.XDG_DATA_HOME?.trim() || path.join(homeDir, ".local", "share");
  return path.join(dataHome, "centraid", "gateway");
}
