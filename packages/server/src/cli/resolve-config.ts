import { loadConfigFile, validateConfig, DaemonConfigError } from "./config.js";
import type { DaemonConfig } from "./config.js";
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
    } catch (error) {
      if (error instanceof DaemonConfigError) fail(error.message, 2);
      throw error;
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
