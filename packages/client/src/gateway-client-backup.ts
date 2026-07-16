/*
 * Renderer-side client for the offsite backup engine's HTTP surface
 * (`GET /centraid/_gateway/backup`, `POST /centraid/_gateway/backup/run`,
 * `POST /centraid/_gateway/backup/kit-confirmed` —
 * `packages/gateway/src/routes/backup-routes.ts`, issue #351's last
 * workstream; wave 4 adds the recovery-kit confirmation gate). Backs the
 * Gateway page's Backup card.
 */

import { auth, authHeaders, doFetch, readJson } from './gateway-client-core.js';

export interface GatewayBackupPolicyDTO {
  rpoSeconds: number;
  snapshotIntervalHours: number;
  verifyEveryDays: number;
  casAck: 'receipt' | 'replicated';
  outboxBudgetBytes: number;
  reservedHeadroomBytes: number;
  cacheBudgetBytes?: number;
  throttleBytesPerSec?: number;
  storageClass?: string;
  walBaseRollBytes: number;
  walBaseRollHours: number;
}

export type GatewayBackupPolicyPatchDTO = {
  [K in keyof GatewayBackupPolicyDTO]?: GatewayBackupPolicyDTO[K] | null;
};

export interface GatewayBackupDestinationDTO {
  kind: 'gateway-local' | 'own-s3' | 'provider';
  connectionId?: string;
}

export interface GatewayBackupDriftDTO {
  count: number;
  sample: string[];
}

export interface GatewayBackupStoreInventoryDTO {
  configured: boolean;
  source: 'provider' | 'bucket' | 'not-configured' | 'unavailable';
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
  mode: 'scheduled' | 'bucket';
  status: 'ok' | 'degraded' | 'error';
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
    source: 'provider' | 'unavailable';
    eventCount: number;
    recent: Array<{ at: number; kind: string; detail: Record<string, unknown> }>;
    error?: string;
  };
}

export interface GatewayProviderPolicyStatusDTO {
  status: 'pending' | 'synced' | 'drift' | 'rejected' | 'unsupported' | 'error';
  checkedAt: string;
  error?: string;
  errorCode?: string;
}

/** One vault's backup state, as `_gateway/backup` reports it. */
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

/**
 * Recovery-kit confirmation gate (issue #351 wave 4 / #367) — deliberately
 * generic, not backup-card-specific: issue #367 reuses this same
 * `{confirmedAt}` shape to gate the S3-storage enable flow.
 */
export interface GatewayRecoveryKitStatusDTO {
  /** Epoch SECONDS the operator last confirmed, or `null` if never. */
  confirmedAt: number | null;
}

export interface GatewayBackupStatusDTO {
  configured: boolean;
  provider?: string;
  vaults: GatewayBackupVaultDTO[];
  recoveryKit: GatewayRecoveryKitStatusDTO;
}

/** Backup status for every mounted vault — `{configured: false, vaults: []}`
 *  when the gateway has no `backup` block. */
export async function getGatewayBackupStatus(): Promise<GatewayBackupStatusDTO> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_gateway/backup', {
    method: 'GET',
    headers: authHeaders(token),
  });
  return readJson<GatewayBackupStatusDTO>(res, 'gateway backup status');
}

/** Replace the supplied fields in one vault's unified backup/bytes policy. */
export async function updateGatewayBackupPolicy(
  vaultId: string,
  patch: GatewayBackupPolicyPatchDTO,
): Promise<{ vaultId: string; policy: GatewayBackupPolicyDTO }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_gateway/backup/policy/${encodeURIComponent(vaultId)}`,
    {
      method: 'PUT',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    },
  );
  return readJson<{ vaultId: string; policy: GatewayBackupPolicyDTO }>(
    res,
    'update gateway backup policy',
  );
}

export interface GatewayBackupRunResultDTO {
  accepted: boolean;
  /** A run was already in flight — this POST didn't enqueue a second one. */
  alreadyRunning?: boolean;
}

/**
 * Trigger an immediate backup of every mounted vault (the Gateway page's
 * "Back up now"). Resolves as soon as the gateway ACCEPTS the request
 * (HTTP 202) — the run itself happens in the background; poll
 * `getGatewayBackupStatus` to see it land. Rejects with a
 * `GatewayClientError` (code `'conflict'`) if backup isn't configured.
 */
export async function runGatewayBackupNow(): Promise<GatewayBackupRunResultDTO> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_gateway/backup/run', {
    method: 'POST',
    headers: authHeaders(token),
  });
  return readJson<GatewayBackupRunResultDTO>(res, 'run gateway backup');
}

/** Trigger an integrity verification of the newest snapshot for every backed-up vault. */
export async function verifyGatewayBackupsNow(): Promise<GatewayBackupRunResultDTO> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_gateway/backup/verify', {
    method: 'POST',
    headers: authHeaders(token),
  });
  return readJson<GatewayBackupRunResultDTO>(res, 'verify gateway backups');
}

/** Cross-check provider-attested inventory against a raw bucket LIST for one vault. */
export async function verifyGatewayBackupBucket(
  vaultId: string,
): Promise<{ vaultId: string; reconciliation: GatewayBackupReconciliationDTO }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_gateway/backup/verify-bucket/${encodeURIComponent(vaultId)}`,
    { method: 'POST', headers: authHeaders(token) },
  );
  return readJson<{ vaultId: string; reconciliation: GatewayBackupReconciliationDTO }>(
    res,
    'verify backup inventory against bucket',
  );
}

/**
 * Confirm the operator has exported and safely stored the recovery kit
 * (the Gateway page's "I've saved my recovery kit" button). Unlike
 * `GatewayRecoveryKitStatusDTO.confirmedAt` (which can be `null` — never
 * confirmed), this POST always stamps the current clock, so the response's
 * `confirmedAt` is always a number. Rejects with a `GatewayClientError`
 * (code `'conflict'`) if backup isn't configured — there's no keyring to
 * have exported a kit from.
 */
export async function confirmGatewayRecoveryKit(): Promise<{ confirmedAt: number }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_gateway/backup/kit-confirmed', {
    method: 'POST',
    headers: authHeaders(token),
  });
  return readJson<{ ok: true; confirmedAt: number }>(res, 'confirm gateway recovery kit');
}
