/*
 * Shared `--config <path>` / `--data-dir <path>` resolution — `serve` and
 * `backup` both need the daemon's full config (the backup CLI constructs
 * its `BackupService` from the SAME resolved config `serve` boots with),
 * so this is split out of `cli.ts` rather than duplicated.
 */

import {
  loadConfigFile,
  validateConfig,
  DaemonConfigError,
  type DaemonConfig,
} from "./config.js";
import { DEFAULT_GATEWAY_PORT, platformDefaultDataDir } from "./data-dir.js";

export interface ConfigSource {
  configPath?: string;
  dataDir?: string;
}

export async function resolveDaemonConfig(
  source: ConfigSource,
  fail: (message: string, code?: number) => never,
  env: NodeJS.ProcessEnv = process.env
): Promise<DaemonConfig> {
  const environmentDir = env.CENTRAID_DATA_DIR?.trim() || undefined;
  let cfg: DaemonConfig;
  if (source.configPath) {
    try {
      cfg = await loadConfigFile(source.configPath);
    } catch (err) {
      if (err instanceof DaemonConfigError) fail(err.message, 2);
      throw err;
    }
  } else {
    cfg = validateConfig({
      dataDir:
        source.dataDir ?? environmentDir ?? platformDefaultDataDir({ env }),
    });
  }
  cfg.dataDir = source.dataDir ?? environmentDir ?? cfg.dataDir;
  cfg.port ??= DEFAULT_GATEWAY_PORT;
  return cfg;
}
