export interface LocalBackupProviderConfig {
  kind: "local";
  dir: string;
}

export interface RemoteBackupProviderConfig {
  kind: "remote";
  endpoint: string;
  apiKey: string;
}

export type BackupProviderConfig =
  | LocalBackupProviderConfig
  | RemoteBackupProviderConfig;

export interface BackupConfig {
  enabled: boolean;
  keyringPath?: string;
  provider: BackupProviderConfig;
}

export class BackupConfigError extends Error {
  constructor(message: string) {
    super(`backup config: ${message}`);
    this.name = "BackupConfigError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateBackupConfig(value: unknown): BackupConfig {
  if (!isRecord(value)) throw new BackupConfigError("must be an object");
  for (const retired of ["intervalHours", "verifyEveryDays"]) {
    if (retired in value) {
      throw new BackupConfigError(
        `\`${retired}\` was removed; configure cadence in each vault's backup policy`
      );
    }
  }
  if (typeof value.enabled !== "boolean") {
    throw new BackupConfigError("`enabled` is required and must be a boolean");
  }
  const out: BackupConfig = {
    enabled: value.enabled,
    provider: validateProvider(value.provider),
  };
  if (value.keyringPath !== undefined) {
    if (
      typeof value.keyringPath !== "string" ||
      value.keyringPath.length === 0
    ) {
      throw new BackupConfigError(
        "`keyringPath` must be a non-empty string when set"
      );
    }
    out.keyringPath = value.keyringPath;
  }
  return out;
}

function validateProvider(value: unknown): BackupProviderConfig {
  if (!isRecord(value))
    throw new BackupConfigError("`provider` is required and must be an object");
  if (value.kind === "local") {
    if (typeof value.dir !== "string" || value.dir.length === 0) {
      throw new BackupConfigError(
        '`provider.dir` is required for kind "local"'
      );
    }
    return { kind: "local", dir: value.dir };
  }
  if (value.kind === "remote") {
    if (typeof value.endpoint !== "string" || value.endpoint.length === 0) {
      throw new BackupConfigError(
        '`provider.endpoint` is required for kind "remote"'
      );
    }
    if (typeof value.apiKey !== "string" || value.apiKey.length === 0) {
      throw new BackupConfigError(
        '`provider.apiKey` is required for kind "remote"'
      );
    }
    return { kind: "remote", endpoint: value.endpoint, apiKey: value.apiKey };
  }
  throw new BackupConfigError('`provider.kind` must be "local" or "remote"');
}
