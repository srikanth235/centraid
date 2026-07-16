/*
 * Renderer-side client for the gateway's storage-connection surface (issue
 * #367 §C1/§D — `packages/gateway/src/routes/storage-routes.ts`). Backs the
 * Gateway page's Storage card (read-only: status + usage) and the Settings
 * → Storage screen (full CRUD + test + the per-vault attach flow).
 *
 *   GET    /centraid/_gateway/storage/connections
 *   POST   /centraid/_gateway/storage/connections
 *   PATCH  /centraid/_gateway/storage/connections/<id>
 *   DELETE /centraid/_gateway/storage/connections/<id>
 *   POST   /centraid/_gateway/storage/connections/<id>/test
 *   GET    /centraid/_gateway/storage/status
 *   GET    /centraid/_gateway/storage/usage
 *   PUT    /centraid/_vault/blob-store        (per-vault attach — vault-routes.ts)
 *
 * Every connection row NEVER carries a secret field, sealed or not — the
 * gateway simply never puts one on the wire (storage-connections.ts).
 */

import { auth, authHeaders, doFetch, enc, readJson } from './gateway-client-core.js';

export type StorageConnectionKind = 'byo-s3' | 'provider';
export type StorageConnectionUse = 'backup' | 'cas';

export interface StorageConnectionDTO {
  id: string;
  kind: StorageConnectionKind;
  name: string;
  uses: StorageConnectionUse[];
  createdAt: string;
  updatedAt: string;
  endpoint?: string;
  region?: string;
  bucket?: string;
  prefix?: string;
  baseUrl?: string;
  targetId?: string;
}

export interface CreateByoS3ConnectionInput {
  kind: 'byo-s3';
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix?: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  uses?: StorageConnectionUse[];
}

export interface CreateProviderConnectionInput {
  kind: 'provider';
  name: string;
  baseUrl: string;
  apiKey: string;
  uses?: StorageConnectionUse[];
}

export type CreateStorageConnectionInput =
  | CreateByoS3ConnectionInput
  | CreateProviderConnectionInput;

/** Thrown for the recovery-kit gate specifically, so callers can branch on
 *  it without string-matching a generic `GatewayClientError`. */
export class RecoveryKitNotConfirmedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecoveryKitNotConfirmedError';
  }
}

/** Every configured storage connection (never carries a secret field). */
export async function listStorageConnections(): Promise<StorageConnectionDTO[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_gateway/storage/connections', {
    method: 'GET',
    headers: authHeaders(token),
  });
  const out = await readJson<{ connections: StorageConnectionDTO[] }>(
    res,
    'list storage connections',
  );
  return out.connections ?? [];
}

/**
 * Create a connection. Refused with `RecoveryKitNotConfirmedError` (HTTP
 * 409) when the connection is usable for `cas` and the operator hasn't
 * confirmed the recovery kit yet — pass `force: true` only from an explicit
 * "proceed anyway" action, never as a default retry.
 */
export async function createStorageConnection(
  input: CreateStorageConnectionInput,
  opts?: { force?: boolean },
): Promise<StorageConnectionDTO> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_gateway/storage/connections', {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({ ...input, ...(opts?.force ? { force: true } : {}) }),
  });
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new RecoveryKitNotConfirmedError(
      body.message ?? 'confirm the recovery kit before enabling a remote storage tier',
    );
  }
  const out = await readJson<{ connection: StorageConnectionDTO }>(
    res,
    'create storage connection',
  );
  return out.connection;
}

export async function updateStorageConnection(
  id: string,
  patch: Partial<CreateStorageConnectionInput>,
): Promise<StorageConnectionDTO> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_gateway/storage/connections/${enc(id)}`, {
    method: 'PATCH',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify(patch),
  });
  const out = await readJson<{ connection: StorageConnectionDTO }>(
    res,
    'update storage connection',
  );
  return out.connection;
}

export async function deleteStorageConnection(id: string): Promise<void> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_gateway/storage/connections/${enc(id)}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  await readJson(res, 'delete storage connection');
}

export type StorageConnectionTestResult =
  | { ok: true; detail: string }
  | { ok: false; error: string };

/** Real signed HEAD probe against the connection's bucket. */
export async function testStorageConnection(id: string): Promise<StorageConnectionTestResult> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_gateway/storage/connections/${enc(id)}/test`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  return readJson<StorageConnectionTestResult>(res, 'test storage connection');
}

/**
 * Bounded storage-tier metrics (issue #405 §7) — process-lifetime custody
 * counters that make cache health visible. All byte/count fields reset on
 * gateway restart. `budgetBytes` is `null` for an unlimited tier (no disk to
 * measure); the card shows an "unlimited" state rather than a budget bar.
 */
export interface StorageCacheStatusDTO {
  spoolBytes: number;
  budgetBytes: number | null;
  localHits: number;
  readThroughs: number;
  rangedRemoteReads: number;
  bytesServedLocal: number;
  bytesServedRemote: number;
  evictedBlobs: number;
  evictedBytes: number;
  backpressureEvents: number;
}

export interface StorageVaultStatusDTO {
  vaultId: string;
  name: string;
  configured: boolean;
  connectionId?: string;
  replicated: { count: number; bytes: number };
  backlog: { count: number; bytes: number };
  pendingOffsite?: {
    count: number;
    bytes: number;
    uploading: number;
    lastError: string | null;
  };
  casAck?: 'receipt' | 'replicated';
  outboxBudgetBytes?: number;
  reservedHeadroomBytes?: number;
  lastSweep: {
    completedAt: string | null;
    lastAttemptedAt: string | null;
    error: string | null;
    consecutiveFailures: number;
  };
  throttleBytesPerSec?: number;
  /** Bounded storage-tier health (issue #405 §7); absent on older gateways. */
  cache?: StorageCacheStatusDTO;
}

/** Per-vault replication progress — backs the Storage card's per-vault rows. */
export async function getStorageStatus(): Promise<StorageVaultStatusDTO[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_gateway/storage/status', {
    method: 'GET',
    headers: authHeaders(token),
  });
  const out = await readJson<{ vaults: StorageVaultStatusDTO[] }>(res, 'storage status');
  return out.vaults ?? [];
}

/**
 * Authenticated custody-transition stream. A strict client uses this as the
 * completion edge: the durable local receipt may already be claimed, while a
 * later event makes the offsite acknowledgment visible without polling lag.
 */
export async function streamStorageCustody(
  onStatus: (vaults: StorageVaultStatusDTO[]) => void,
  signal: AbortSignal,
): Promise<void> {
  const { baseUrl, token } = await auth();
  try {
    const res = await doFetch(baseUrl, '/centraid/_gateway/storage/status/events', {
      method: 'GET',
      headers: authHeaders(token),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`storage custody stream failed (HTTP ${res.status})`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        try {
          const parsed = JSON.parse(data) as { vaults?: StorageVaultStatusDTO[] };
          if (Array.isArray(parsed.vaults)) onStatus(parsed.vaults);
        } catch {
          // A malformed frame is isolated; the next custody event remains useful.
        }
      }
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}

/** One store class's usage figures, as `centraid-storage-provider/1` reports them. */
export interface StoreUsageReportDTO {
  bytesStored: number;
  objectCount: number;
  opCounts?: Record<string, number>;
  quotaBytes: number | null;
  period: { start: number; end: number };
}

export interface StorageConnectionUsageDTO {
  connectionId: string;
  kind: StorageConnectionKind;
  /** `null` for byo-s3 (no metering endpoint) or before the first successful poll. */
  providerReported: Partial<Record<'backup' | 'cas', StoreUsageReportDTO>> | null;
  /** Locally-computed replicated bytes (custody's own ground truth) — compare
   *  against `providerReported` for an honest drift/integrity read. */
  localReplicatedBytes: number;
  fetchedAt?: string;
  error?: string;
}

/** Per-connection usage — the quota bar's data source. */
export async function getStorageUsage(): Promise<StorageConnectionUsageDTO[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_gateway/storage/usage', {
    method: 'GET',
    headers: authHeaders(token),
  });
  const out = await readJson<{ connections: StorageConnectionUsageDTO[] }>(res, 'storage usage');
  return out.connections ?? [];
}

export interface BlobStoreSettingsDTO {
  kind: 'fs' | 's3';
  connectionId?: string;
  connectionKind?: StorageConnectionKind;
  endpoint?: string;
  region?: string;
  bucket?: string;
  prefix?: string;
  encrypt?: boolean;
}

/** The addressed vault's current byte-custody settings. */
export async function getVaultBlobStore(): Promise<BlobStoreSettingsDTO> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_vault/blob-store', {
    method: 'GET',
    headers: authHeaders(token),
  });
  const out = await readJson<{ blob_store: BlobStoreSettingsDTO }>(res, 'get vault blob store');
  return out.blob_store;
}

/**
 * Attach a storage connection to the addressed vault's CAS remote tier
 * (`PUT /centraid/_vault/blob-store`, vault-routes.ts). Refused with
 * `RecoveryKitNotConfirmedError` (409) the same way `createStorageConnection`
 * is — pass `force: true` only from an explicit "proceed anyway" action.
 */
export async function attachVaultStorageConnection(
  connectionId: string,
  opts?: { force?: boolean },
): Promise<BlobStoreSettingsDTO> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_vault/blob-store', {
    method: 'PUT',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({
      blob_store: { kind: 's3', connectionId },
      ...(opts?.force ? { force: true } : {}),
    }),
  });
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new RecoveryKitNotConfirmedError(
      body.message ?? 'confirm the recovery kit before enabling a remote storage tier',
    );
  }
  const out = await readJson<{ blob_store: BlobStoreSettingsDTO }>(
    res,
    'attach storage connection',
  );
  return out.blob_store;
}

/** Revert the addressed vault to local-only storage (`blob_store: {kind:
 *  'fs'}`) — never gated by the recovery kit; going local-only is always safe. */
export async function detachVaultStorageConnection(): Promise<BlobStoreSettingsDTO> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_vault/blob-store', {
    method: 'PUT',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({ blob_store: { kind: 'fs' } }),
  });
  const out = await readJson<{ blob_store: BlobStoreSettingsDTO }>(res, 'detach vault storage');
  return out.blob_store;
}
