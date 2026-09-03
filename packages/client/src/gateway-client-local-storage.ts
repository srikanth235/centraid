import { auth, authHeaders, doFetch, readJson } from "./gateway-client-core.js";

export type LocalComponentId =
  | "ledger"
  | "vault-db"
  | "attachments"
  | "apps"
  | "code"
  | "backup"
  | "logs"
  | "cache"
  | "templates"
  | "storage";

export interface LocalComponentUsageDTO {
  component: LocalComponentId;
  bytes: number;
  files: number | null;
  unreadable?: string;
}

export interface LocalVaultUsageDTO {
  vaultId: string;
  name?: string;
  bytes: number;
  components: LocalComponentUsageDTO[];
}

export interface StorageLimitsDTO {
  totalLimitBytes: number | null;
  warnAtPercent: number;
  journalLimitBytes: number | null;
}

export interface StorageLimitEvaluationDTO {
  status: "ok" | "degraded" | "error";
  fractionUsed: number | null;
  usedBytes: number;
  limitBytes: number | null;
}

export interface LocalUsageReportDTO {
  scannedAt: number;
  totalBytes: number;
  components: LocalComponentUsageDTO[];
  vaults: LocalVaultUsageDTO[];
  disk: { freeBytes: number; totalBytes: number } | null;
  limits: StorageLimitsDTO;
  limit: StorageLimitEvaluationDTO;
  error?: string;
}

export async function getLocalStorageUsage(
  opts: { refresh?: boolean } = {}
): Promise<LocalUsageReportDTO> {
  const { baseUrl, token } = await auth();
  const path = opts.refresh
    ? "/centraid/_gateway/storage/local?refresh=1"
    : "/centraid/_gateway/storage/local";
  const res = await doFetch(baseUrl, path, {
    method: "GET",
    headers: authHeaders(token),
  });
  return readJson<LocalUsageReportDTO>(res, "local storage usage");
}

export async function getStorageLimits(): Promise<StorageLimitsDTO> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_gateway/storage/limits", {
    method: "GET",
    headers: authHeaders(token),
  });
  const out = await readJson<{ limits: StorageLimitsDTO }>(
    res,
    "storage limits"
  );
  return out.limits;
}

export interface StorageLimitsPatchDTO {
  totalLimitBytes?: number | null;
  warnAtPercent?: number;
  journalLimitBytes?: number | null;
}

export async function updateStorageLimits(
  patch: StorageLimitsPatchDTO
): Promise<StorageLimitsDTO> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_gateway/storage/limits", {
    method: "PUT",
    headers: authHeaders(token, "application/json"),
    body: JSON.stringify(patch),
  });
  const out = await readJson<{ limits: StorageLimitsDTO }>(
    res,
    "update storage limits"
  );
  return out.limits;
}
