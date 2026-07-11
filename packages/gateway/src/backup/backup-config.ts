/*
 * Config shape for the offsite backup service (issue: backup provider
 * contract wiring). Threaded through `BuildGatewayOptions.backup` (see
 * `build-gateway.ts`) and the daemon's JSON config file (`cli/config.ts`)
 * under the same `"backup"` key, so a `centraid-gateway serve --config`
 * file and an in-process embed (the Electron desktop) describe the same
 * shape.
 */

export interface LocalBackupProviderConfig {
  kind: 'local';
  /** Root directory the `LocalBackupProvider` writes `objects/` + `registry.json` under. */
  dir: string;
}

export interface RemoteBackupProviderConfig {
  kind: 'remote';
  /** e.g. `https://api.clawgnition.com`. */
  endpoint: string;
  apiKey: string;
}

export type BackupProviderConfig = LocalBackupProviderConfig | RemoteBackupProviderConfig;

export interface BackupConfig {
  enabled: boolean;
  /** Backup tick cadence. Default 24. */
  intervalHours?: number;
  /** Verification cadence. Default 7. */
  verifyEveryDays?: number;
  /** Default `<dataDir>/backup/keyring.json`. */
  keyringPath?: string;
  provider: BackupProviderConfig;
}

export const DEFAULT_INTERVAL_HOURS = 24;
export const DEFAULT_VERIFY_EVERY_DAYS = 7;

export function intervalHoursOf(config: BackupConfig): number {
  return config.intervalHours ?? DEFAULT_INTERVAL_HOURS;
}

export function verifyEveryDaysOf(config: BackupConfig): number {
  return config.verifyEveryDays ?? DEFAULT_VERIFY_EVERY_DAYS;
}

export class BackupConfigError extends Error {
  constructor(message: string) {
    super(`backup config: ${message}`);
    this.name = 'BackupConfigError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate an untyped JSON value (the daemon config file's `"backup"` key). */
export function validateBackupConfig(value: unknown): BackupConfig {
  if (!isRecord(value)) throw new BackupConfigError('must be an object');
  if (typeof value.enabled !== 'boolean') {
    throw new BackupConfigError('`enabled` is required and must be a boolean');
  }
  const out: BackupConfig = { enabled: value.enabled, provider: validateProvider(value.provider) };
  if (value.intervalHours !== undefined) {
    if (typeof value.intervalHours !== 'number' || value.intervalHours <= 0) {
      throw new BackupConfigError('`intervalHours` must be a positive number when set');
    }
    out.intervalHours = value.intervalHours;
  }
  if (value.verifyEveryDays !== undefined) {
    if (typeof value.verifyEveryDays !== 'number' || value.verifyEveryDays <= 0) {
      throw new BackupConfigError('`verifyEveryDays` must be a positive number when set');
    }
    out.verifyEveryDays = value.verifyEveryDays;
  }
  if (value.keyringPath !== undefined) {
    if (typeof value.keyringPath !== 'string' || value.keyringPath.length === 0) {
      throw new BackupConfigError('`keyringPath` must be a non-empty string when set');
    }
    out.keyringPath = value.keyringPath;
  }
  return out;
}

function validateProvider(value: unknown): BackupProviderConfig {
  if (!isRecord(value)) throw new BackupConfigError('`provider` is required and must be an object');
  if (value.kind === 'local') {
    if (typeof value.dir !== 'string' || value.dir.length === 0) {
      throw new BackupConfigError('`provider.dir` is required for kind "local"');
    }
    return { kind: 'local', dir: value.dir };
  }
  if (value.kind === 'remote') {
    if (typeof value.endpoint !== 'string' || value.endpoint.length === 0) {
      throw new BackupConfigError('`provider.endpoint` is required for kind "remote"');
    }
    if (typeof value.apiKey !== 'string' || value.apiKey.length === 0) {
      throw new BackupConfigError('`provider.apiKey` is required for kind "remote"');
    }
    return { kind: 'remote', endpoint: value.endpoint, apiKey: value.apiKey };
  }
  throw new BackupConfigError('`provider.kind` must be "local" or "remote"');
}
