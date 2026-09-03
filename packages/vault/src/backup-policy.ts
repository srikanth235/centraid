import type { DatabaseSync } from "node:sqlite";

export interface BackupPolicy {
  rpoSeconds: number;
  snapshotIntervalHours: number;
  verifyEveryDays: number;
  casAck: "receipt" | "replicated";
  outboxBudgetBytes: number;
  reservedHeadroomBytes: number;
  cacheBudgetBytes?: number;
  throttleBytesPerSec?: number;
  storageClass?: string;
  directToColdOriginals?: {
    enabled?: boolean;
    minBytes?: number;
    mimePrefixes?: string[];
  };
  walBaseRollBytes: number;
  walBaseRollHours: number;
}

export type BackupPolicyPatch = {
  [K in keyof BackupPolicy]?: BackupPolicy[K] | null;
};

export const MIN_RPO_SECONDS = 30;
export const DEFAULT_BACKUP_POLICY: Readonly<BackupPolicy> = Object.freeze({
  rpoSeconds: 60,
  snapshotIntervalHours: 24,
  verifyEveryDays: 7,
  casAck: "receipt",
  outboxBudgetBytes: 512 * 1024 ** 2,
  reservedHeadroomBytes: 256 * 1024 ** 2,
  walBaseRollBytes: 16 * 1024 ** 2,
  walBaseRollHours: 24,
});

export class BackupPolicyError extends Error {
  constructor(message: string) {
    super(`backup policy: ${message}`);
    this.name = "BackupPolicyError";
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function positiveNumber(value: unknown, field: string, floor = 0): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < floor ||
    value <= 0
  ) {
    throw new BackupPolicyError(
      `\`${field}\` must be a finite number ${floor > 0 ? `>= ${floor}` : "> 0"}`
    );
  }
  return value;
}

function positiveInteger(value: unknown, field: string, floor = 0): number {
  const number = positiveNumber(value, field, floor);
  if (!Number.isInteger(number)) {
    throw new BackupPolicyError(`\`${field}\` must be an integer`);
  }
  return number;
}

function optionalPositiveNumber(
  value: unknown,
  field: string
): number | undefined {
  if (value === undefined || value === null || value === 0) return undefined;
  return positiveNumber(value, field);
}

function optionalColdOriginals(
  value: unknown
):
  | { enabled?: boolean; minBytes?: number; mimePrefixes?: string[] }
  | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new BackupPolicyError("`directToColdOriginals` must be an object");
  }
  const raw = value as Record<string, unknown>;
  const out: { enabled?: boolean; minBytes?: number; mimePrefixes?: string[] } =
    {};
  if (raw.enabled !== undefined && raw.enabled !== null) {
    if (typeof raw.enabled !== "boolean") {
      throw new BackupPolicyError(
        "`directToColdOriginals.enabled` must be a boolean"
      );
    }
    out.enabled = raw.enabled;
  }
  if (raw.minBytes !== undefined && raw.minBytes !== null) {
    out.minBytes = positiveInteger(
      raw.minBytes,
      "directToColdOriginals.minBytes"
    );
  }
  if (raw.mimePrefixes !== undefined && raw.mimePrefixes !== null) {
    if (
      !Array.isArray(raw.mimePrefixes) ||
      !raw.mimePrefixes.every((p) => typeof p === "string" && p.length > 0)
    ) {
      throw new BackupPolicyError(
        "`directToColdOriginals.mimePrefixes` must be an array of non-empty strings"
      );
    }
    out.mimePrefixes = raw.mimePrefixes as string[];
  }
  return out;
}

export function resolveBackupPolicy(value: unknown): BackupPolicy {
  const raw = record(value);
  const casAck = raw.casAck ?? DEFAULT_BACKUP_POLICY.casAck;
  if (casAck !== "receipt" && casAck !== "replicated") {
    throw new BackupPolicyError('`casAck` must be "receipt" or "replicated"');
  }
  const storageClassRaw = raw.storageClass;
  const directToColdOriginals = optionalColdOriginals(
    raw.directToColdOriginals
  );
  const cacheBudgetBytes = optionalPositiveNumber(
    raw.cacheBudgetBytes,
    "cacheBudgetBytes"
  );
  const throttleBytesPerSec = optionalPositiveNumber(
    raw.throttleBytesPerSec,
    "throttleBytesPerSec"
  );
  if (
    storageClassRaw !== undefined &&
    storageClassRaw !== null &&
    typeof storageClassRaw !== "string"
  ) {
    throw new BackupPolicyError("`storageClass` must be a string when set");
  }
  const storageClass =
    typeof storageClassRaw === "string" && storageClassRaw.trim() !== ""
      ? storageClassRaw.trim()
      : undefined;
  return {
    rpoSeconds: positiveInteger(
      raw.rpoSeconds ?? DEFAULT_BACKUP_POLICY.rpoSeconds,
      "rpoSeconds",
      MIN_RPO_SECONDS
    ),
    snapshotIntervalHours: positiveInteger(
      raw.snapshotIntervalHours ?? DEFAULT_BACKUP_POLICY.snapshotIntervalHours,
      "snapshotIntervalHours"
    ),
    verifyEveryDays: positiveInteger(
      raw.verifyEveryDays ?? DEFAULT_BACKUP_POLICY.verifyEveryDays,
      "verifyEveryDays"
    ),
    casAck,
    outboxBudgetBytes: positiveNumber(
      raw.outboxBudgetBytes ?? DEFAULT_BACKUP_POLICY.outboxBudgetBytes,
      "outboxBudgetBytes"
    ),
    reservedHeadroomBytes: positiveNumber(
      raw.reservedHeadroomBytes ?? DEFAULT_BACKUP_POLICY.reservedHeadroomBytes,
      "reservedHeadroomBytes"
    ),
    ...(cacheBudgetBytes === undefined ? {} : { cacheBudgetBytes }),
    ...(throttleBytesPerSec === undefined ? {} : { throttleBytesPerSec }),
    ...(storageClass === undefined ? {} : { storageClass }),
    ...(directToColdOriginals === undefined ? {} : { directToColdOriginals }),
    walBaseRollBytes: positiveNumber(
      raw.walBaseRollBytes ?? DEFAULT_BACKUP_POLICY.walBaseRollBytes,
      "walBaseRollBytes"
    ),
    walBaseRollHours: positiveNumber(
      raw.walBaseRollHours ?? DEFAULT_BACKUP_POLICY.walBaseRollHours,
      "walBaseRollHours"
    ),
  };
}

function readSettings(vault: DatabaseSync): Record<string, unknown> {
  const row = vault
    .prepare("SELECT settings_json FROM core_vault LIMIT 1")
    .get() as { settings_json: string | null } | undefined;
  if (!row?.settings_json) return {};
  try {
    return record(JSON.parse(row.settings_json));
  } catch {
    return {};
  }
}

export function readBackupPolicy(vault: DatabaseSync): BackupPolicy {
  const settings = readSettings(vault);
  const policy = record(settings.backup_policy);
  const legacy = record(settings.blob_store);
  return resolveBackupPolicy({
    ...policy,
    ...(policy.throttleBytesPerSec === undefined &&
    legacy.throttleBytesPerSec !== undefined
      ? { throttleBytesPerSec: legacy.throttleBytesPerSec }
      : {}),
    ...(policy.storageClass === undefined && legacy.storageClass !== undefined
      ? { storageClass: legacy.storageClass }
      : {}),
  });
}

export function updateBackupPolicy(
  vault: DatabaseSync,
  patch: BackupPolicyPatch
): BackupPolicy {
  const settings = readSettings(vault);
  const current = record(settings.backup_policy);
  for (const key of Object.keys(patch) as (keyof BackupPolicy)[]) {
    const value = patch[key];
    if (value === null || value === undefined) delete current[key];
    else current[key] = value;
  }
  const resolved = resolveBackupPolicy(current);
  settings.backup_policy = resolved;
  vault
    .prepare("UPDATE core_vault SET settings_json = ?")
    .run(JSON.stringify(settings));
  return resolved;
}
