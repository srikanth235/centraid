/*
 * Renderer client for gateway storage-connections (#367). A connection row
 * NEVER carries a secret field — the gateway never puts one on the wire.
 */

/* oxlint-disable max-classes-per-file -- the two typed gate errors (recovery-kit + home-profile) are one storage-connection boundary (#436) */

import {
  auth,
  authHeaders,
  doFetch,
  enc,
  readJson,
} from "./gateway-client-core.js";
import { consumeSseFrames, frameData } from "./turn-stream.js";

/** One kind only (#436): every connection is a managed provider home bundle. */
export type StorageConnectionKind = "provider";

export interface StorageConnectionDTO {
  id: string;
  kind: StorageConnectionKind;
  name: string;
  createdAt: string;
  updatedAt: string;
  endpoint?: string;
  region?: string;
  bucket?: string;
  prefix?: string;
  baseUrl?: string;
  targetId?: string;
}

export interface CreateProviderConnectionInput {
  kind: "provider";
  name: string;
  baseUrl: string;
  apiKey: string;
}

export type CreateStorageConnectionInput = CreateProviderConnectionInput;

/** Recovery-kit gate — branch on this, do not string-match `GatewayClientError`. */
export class RecoveryKitNotConfirmedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryKitNotConfirmedError";
  }
}

/** 400 `provider_not_home_profile` (#436 §1). Carries missing caps for the UI. */
export class ProviderNotHomeProfileError extends Error {
  readonly missingCapabilities: string[];
  constructor(message: string, missingCapabilities: string[]) {
    super(message);
    this.name = "ProviderNotHomeProfileError";
    this.missingCapabilities = missingCapabilities;
  }
}

/** Parse `(missing a, b, c)` from the gateway message. Empty when unnamed. */
function parseMissingCapabilities(message: string | undefined): string[] {
  const match = /missing (?<capabilities>[^)]+)\)/u.exec(message ?? "");
  const capabilities = match?.groups?.capabilities;
  if (!capabilities) return [];
  return capabilities
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

export async function listStorageConnections(): Promise<
  StorageConnectionDTO[]
> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_gateway/storage/connections", {
    method: "GET",
    headers: authHeaders(token),
  });
  const out = await readJson<{ connections: StorageConnectionDTO[] }>(
    res,
    "list storage connections"
  );
  return out.connections ?? [];
}

/** 409 `RecoveryKitNotConfirmedError` until the current recovery kit is verified. */
export async function createStorageConnection(
  input: CreateStorageConnectionInput
): Promise<StorageConnectionDTO> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_gateway/storage/connections", {
    method: "POST",
    headers: authHeaders(token, "application/json"),
    body: JSON.stringify(input),
  });
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new RecoveryKitNotConfirmedError(
      body.message ??
        "confirm the recovery kit before enabling a remote storage tier"
    );
  }
  if (res.status === 400) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    if (body.error === "provider_not_home_profile") {
      throw new ProviderNotHomeProfileError(
        body.message ?? "this provider does not advertise the home profile",
        parseMissingCapabilities(body.message)
      );
    }
    throw new Error(
      body.message ?? "create storage connection failed (HTTP 400)"
    );
  }
  const out = await readJson<{ connection: StorageConnectionDTO }>(
    res,
    "create storage connection"
  );
  return out.connection;
}

export async function updateStorageConnection(
  id: string,
  patch: Partial<CreateStorageConnectionInput>
): Promise<StorageConnectionDTO> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_gateway/storage/connections/${enc(id)}`,
    {
      method: "PATCH",
      headers: authHeaders(token, "application/json"),
      body: JSON.stringify(patch),
    }
  );
  const out = await readJson<{ connection: StorageConnectionDTO }>(
    res,
    "update storage connection"
  );
  return out.connection;
}

export async function deleteStorageConnection(id: string): Promise<void> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_gateway/storage/connections/${enc(id)}`,
    {
      method: "DELETE",
      headers: authHeaders(token),
    }
  );
  await readJson(res, "delete storage connection");
}

export type StorageConnectionTestResult =
  | { ok: true; detail: string }
  | { ok: false; error: string };

export async function testStorageConnection(
  id: string
): Promise<StorageConnectionTestResult> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_gateway/storage/connections/${enc(id)}/test`,
    {
      method: "POST",
      headers: authHeaders(token),
    }
  );
  return readJson<StorageConnectionTestResult>(res, "test storage connection");
}

/** Process-lifetime custody counters (#405). Reset on restart; `budgetBytes` null = unlimited. */
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
  casAck?: "receipt" | "replicated";
  outboxBudgetBytes?: number;
  reservedHeadroomBytes?: number;
  lastSweep: {
    completedAt: string | null;
    lastAttemptedAt: string | null;
    error: string | null;
    consecutiveFailures: number;
  };
  throttleBytesPerSec?: number;
  /** Absent on older gateways (#405). */
  cache?: StorageCacheStatusDTO;
}

export async function getStorageStatus(): Promise<StorageVaultStatusDTO[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_gateway/storage/status", {
    method: "GET",
    headers: authHeaders(token),
  });
  const out = await readJson<{ vaults: StorageVaultStatusDTO[] }>(
    res,
    "storage status"
  );
  return out.vaults ?? [];
}

/** Completion edge for offsite ack — local receipt may already be claimed. */
export async function streamStorageCustody(
  onStatus: (vaults: StorageVaultStatusDTO[]) => void,
  signal: AbortSignal
): Promise<void> {
  const { baseUrl, token } = await auth();
  try {
    const res = await doFetch(
      baseUrl,
      "/centraid/_gateway/storage/status/events",
      {
        method: "GET",
        headers: authHeaders(token),
        signal,
      }
    );
    if (!res.ok || !res.body)
      throw new Error(`storage custody stream failed (HTTP ${res.status})`);
    await consumeSseFrames(
      res.body,
      (frame) => {
        const data = frameData(frame);
        if (!data) return;
        try {
          const parsed = JSON.parse(data) as {
            vaults?: StorageVaultStatusDTO[];
          };
          if (Array.isArray(parsed.vaults)) onStatus(parsed.vaults);
        } catch {
          // Isolate a malformed frame; the next custody event remains useful.
        }
      },
      { signal }
    );
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}

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
  /** `null` before first poll or if unmetered. Keyed by store class (PROTOCOL.md). */
  providerReported: Partial<
    Record<"backup" | "cas" | "derived", StoreUsageReportDTO>
  > | null;
  /** Custody's own ground truth — compare against `providerReported` for drift. */
  localReplicatedBytes: number;
  fetchedAt?: string;
  error?: string;
}

export async function getStorageUsage(): Promise<StorageConnectionUsageDTO[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_gateway/storage/usage", {
    method: "GET",
    headers: authHeaders(token),
  });
  const out = await readJson<{ connections: StorageConnectionUsageDTO[] }>(
    res,
    "storage usage"
  );
  return out.connections ?? [];
}

export interface BlobStoreSettingsDTO {
  kind: "fs" | "s3";
  connectionId?: string;
  connectionKind?: "provider";
  endpoint?: string;
  region?: string;
  bucket?: string;
  prefix?: string;
  encrypt?: boolean;
}

export async function getVaultBlobStore(): Promise<BlobStoreSettingsDTO> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_vault/blob-store", {
    method: "GET",
    headers: authHeaders(token),
  });
  const out = await readJson<{ blob_store: BlobStoreSettingsDTO }>(
    res,
    "get vault blob store"
  );
  return out.blob_store;
}

/** 409 `RecoveryKitNotConfirmedError` — no bypass for exporting live remote custody. */
export async function attachVaultStorageConnection(
  connectionId: string
): Promise<BlobStoreSettingsDTO> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_vault/blob-store", {
    method: "PUT",
    headers: authHeaders(token, "application/json"),
    body: JSON.stringify({ blob_store: { kind: "s3", connectionId } }),
  });
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new RecoveryKitNotConfirmedError(
      body.message ??
        "confirm the recovery kit before enabling a remote storage tier"
    );
  }
  const out = await readJson<{ blob_store: BlobStoreSettingsDTO }>(
    res,
    "attach storage connection"
  );
  return out.blob_store;
}

/** Local-only (`kind: 'fs'`) — never gated by the recovery kit. */
export async function detachVaultStorageConnection(): Promise<BlobStoreSettingsDTO> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_vault/blob-store", {
    method: "PUT",
    headers: authHeaders(token, "application/json"),
    body: JSON.stringify({ blob_store: { kind: "fs" } }),
  });
  const out = await readJson<{ blob_store: BlobStoreSettingsDTO }>(
    res,
    "detach vault storage"
  );
  return out.blob_store;
}
