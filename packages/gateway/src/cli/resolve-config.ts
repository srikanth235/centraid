/*
 * Shared `--config <path>` / `--data-dir <path>` resolution — `serve` and
 * `backup` both need the daemon's full config (the backup CLI constructs
 * its `BackupService` from the SAME resolved config `serve` boots with),
 * so this is split out of `cli.ts` rather than duplicated.
 */

import { loadConfigFile, validateConfig, DaemonConfigError, type DaemonConfig } from './config.js';

export interface ConfigSource {
  configPath?: string;
  dataDir?: string;
}

export async function resolveDaemonConfig(
  source: ConfigSource,
  fail: (message: string, code?: number) => never,
): Promise<DaemonConfig> {
  let cfg: DaemonConfig;
  if (source.configPath) {
    try {
      cfg = await loadConfigFile(source.configPath);
    } catch (err) {
      if (err instanceof DaemonConfigError) fail(err.message, 2);
      throw err;
    }
  } else if (source.dataDir) {
    cfg = validateConfig({ dataDir: source.dataDir });
  } else {
    fail('one of --config or --data-dir is required', 2);
  }
  if (source.dataDir) cfg.dataDir = source.dataDir;
  return cfg;
}
