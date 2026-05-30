import type { HarnessConfig } from './types.js';

/** Built-in defaults. Desktop layers user settings on top. */
export function defaultHarnessConfig(): HarnessConfig {
  return {
    gatewayUrl: 'http://127.0.0.1:18789',
    gatewayToken: '',
  };
}

/** Merge partial overrides over the defaults, dropping unknown keys. */
export function resolveHarnessConfig(overrides: Partial<HarnessConfig> | undefined): HarnessConfig {
  const base = defaultHarnessConfig();
  if (!overrides) return base;
  return {
    gatewayUrl: overrides.gatewayUrl?.trim() || base.gatewayUrl,
    gatewayToken: overrides.gatewayToken ?? base.gatewayToken,
  };
}
