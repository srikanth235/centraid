import os from 'node:os';
import path from 'node:path';
import type { HarnessConfig } from './types.js';

/** Built-in defaults. Desktop layers user settings on top. */
export function defaultHarnessConfig(): HarnessConfig {
  return {
    projectsDir: path.join(os.homedir(), 'centraid-projects'),
    gatewayUrl: 'http://127.0.0.1:7575',
    gatewayToken: '',
  };
}

/** Merge partial overrides over the defaults, dropping unknown keys. */
export function resolveHarnessConfig(overrides: Partial<HarnessConfig> | undefined): HarnessConfig {
  const base = defaultHarnessConfig();
  if (!overrides) return base;
  return {
    projectsDir: overrides.projectsDir?.trim() || base.projectsDir,
    gatewayUrl: overrides.gatewayUrl?.trim() || base.gatewayUrl,
    gatewayToken: overrides.gatewayToken ?? base.gatewayToken,
  };
}
