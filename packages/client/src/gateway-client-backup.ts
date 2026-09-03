import { auth, authHeaders, doFetch, readJson } from "./gateway-client-core.js";

export interface GatewayBackupPolicyDTO {
  rpoSeconds: number;
  snapshotIntervalHours: number;
  verifyEveryDays: number;
  casAck: "receipt" | "replicated";
  outboxBudgetBytes: number;
  reservedHeadroomBytes: number;
  cacheBudgetBytes?: number;
  throttleBytesPerSec?: number;
  storageClass?: string;
  walBaseRollBytes: number;
  walBaseRollHours: number;
}

export type GatewayBackupPolicyPatchDTO = {
  [K in keyof Omit<GatewayBackupPolicyDTO, "casAck" | "storageClass">]?:
    | GatewayBackupPolicyDTO[K]
    | null;
};

export interface GatewayBackupDestinationDTO {
  kind: "gateway-local" | "provider";
  connectionId?: string;
}

export interface GatewayBackupDriftDTO {
  count: number;
  sample: string[];
}

export interface GatewayBackupStoreInventoryDTO {
  configured: boolean;
  source: "provider" | "bucket" | "not-configured" | "unavailable";
  providerAttested: boolean;
  objectCount: number;
  bytes: number;
  softDeletedCount: number;
  missing: GatewayBackupDriftDTO;
  orphans: GatewayBackupDriftDTO;
  attestationDrift?: {
    providerOnly: GatewayBackupDriftDTO;
    bucketOnly: GatewayBackupDriftDTO;
    metadataMismatch: GatewayBackupDriftDTO;
  };
  attestationError?: string;
  error?: string;
}

export interface GatewayBackupSnapshotInventoryDTO {
  seq: number;
  totalBytes: number;
  objectCount: number;
  createdAt: number;
  prunedAt: number | null;
  format: string;
}

export interface GatewayBackupReconciliationDTO {
  checkedAt: string;
  mode: "scheduled" | "bucket";
  status: "ok" | "degraded" | "error";
  backup: GatewayBackupStoreInventoryDTO;
  cas: GatewayBackupStoreInventoryDTO;
  walGaps: GatewayBackupDriftDTO;
  snapshots: {
    live: number;
    pruned: number;
    recent: GatewayBackupSnapshotInventoryDTO[];
  };
  walCoverage: {
    earliestTickMs: number | null;
    latestTickMs: number | null;
    spanDays: number | null;
    segmentCount: number;
    markerCount: number;
  };
  audit: {
    source: "provider" | "unavailable";
    eventCount: number;
    recent: Array<{
      at: number;
      kind: string;
      detail: Record<string, unknown>;
    }>;
    error?: string;
  };
}

export interface GatewayProviderPolicyStatusDTO {
  status: "pending" | "synced" | "drift" | "rejected" | "unsupported" | "error";
  checkedAt: string;
  error?: string;
  errorCode?: string;
}

export interface GatewayBackupVaultDTO {
  vaultId: string;
  name?: string;
  lastBackupAt?: string;
  lastVerifyAt?: string;
  lastWalDrainAt?: string;
  lastError?: string;
  running?: boolean;
  policy: GatewayBackupPolicyDTO;
  destination: GatewayBackupDestinationDTO;
  pendingOffsite: { count: number; bytes: number };
  providerPolicy?: GatewayProviderPolicyStatusDTO;
  reconciliation?: GatewayBackupReconciliationDTO;
}

export interface GatewayRecoveryKitStatusDTO {
  confirmedAt: number | null;
}

export type GatewayRetentionDTO =
  | {
      kind: "ladder";
      keepAllDays: number;
      dailyDays: number;
      weeklyDays: number;
    }
  | { kind: "none" };

export interface GatewayHomeDiscoveryDTO {
  retention: GatewayRetentionDTO;
  restoreCostClass: "free-egress" | "metered-egress";
}

export interface GatewayBackupStatusDTO {
  configured: boolean;
  provider?: string;
  vaults: GatewayBackupVaultDTO[];
  recoveryKit: GatewayRecoveryKitStatusDTO;
  home?: GatewayHomeDiscoveryDTO;
}

export async function getGatewayBackupStatus(): Promise<GatewayBackupStatusDTO> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_gateway/backup", {
    method: "GET",
    headers: authHeaders(token),
  });
  return readJson<GatewayBackupStatusDTO>(res, "gateway backup status");
}

export async function updateGatewayBackupPolicy(
  vaultId: string,
  patch: GatewayBackupPolicyPatchDTO
): Promise<{ vaultId: string; policy: GatewayBackupPolicyDTO }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_gateway/backup/policy/${encodeURIComponent(vaultId)}`,
    {
      method: "PUT",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }
  );
  return readJson<{ vaultId: string; policy: GatewayBackupPolicyDTO }>(
    res,
    "update gateway backup policy"
  );
}

export interface GatewayBackupRunResultDTO {
  accepted: boolean;
  alreadyRunning?: boolean;
}

export async function runGatewayBackupNow(): Promise<GatewayBackupRunResultDTO> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_gateway/backup/run", {
    method: "POST",
    headers: authHeaders(token),
  });
  return readJson<GatewayBackupRunResultDTO>(res, "run gateway backup");
}

export async function verifyGatewayBackupsNow(): Promise<GatewayBackupRunResultDTO> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_gateway/backup/verify", {
    method: "POST",
    headers: authHeaders(token),
  });
  return readJson<GatewayBackupRunResultDTO>(res, "verify gateway backups");
}

export async function verifyGatewayBackupBucket(vaultId: string): Promise<{
  vaultId: string;
  reconciliation: GatewayBackupReconciliationDTO;
}> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_gateway/backup/verify-bucket/${encodeURIComponent(vaultId)}`,
    { method: "POST", headers: authHeaders(token) }
  );
  return readJson<{
    vaultId: string;
    reconciliation: GatewayBackupReconciliationDTO;
  }>(res, "verify backup inventory against bucket");
}

export async function confirmGatewayRecoveryKit(input: {
  kit: unknown;
  password: string;
  lossConsent: true;
}): Promise<{ confirmedAt: number }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    "/centraid/_gateway/backup/kit-confirmed",
    {
      method: "POST",
      headers: authHeaders(token, "application/json"),
      body: JSON.stringify(input),
    }
  );
  return readJson<{ ok: true; confirmedAt: number }>(
    res,
    "confirm gateway recovery kit"
  );
}
