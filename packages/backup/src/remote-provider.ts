/*
 * `RemoteBackupProvider` — the client side of `centraid-storage-provider/1`
 * (PROTOCOL.md § Routes) over `fetch`. Every route, verbatim:
 *
 *   GET    /v1/backup/provider                       discovery/capabilities
 *   POST   /v1/backup/vaults                          create target
 *   GET    /v1/backup/vaults                          list + usage + accountStatus
 *   POST   /v1/backup/vaults/:id/credentials          issue grant (any store class)
 *   GET    /v1/backup/vaults/:id/usage                per-store-class usage (optional `usage` capability)
 *   POST   /v1/backup/vaults/:id/snapshots            register (backup store)
 *   GET    /v1/backup/vaults/:id/snapshots            list (backup store)
 *   GET    /v1/backup/vaults/:id/snapshots/:seq       one row (backup store)
 *   DELETE /v1/backup/vaults/:id                      soft delete
 *   POST   /v1/backup/vaults/:id/undelete             cancel soft delete
 *   POST   /v1/backup/vaults/:id/purge                interactive-tier purge
 *
 * There is no single-target GET route in PROTOCOL.md — `getTarget`/`usage`
 * resolve from the list route and filter by id, throwing `not_found` when
 * absent (a deliberate, spec-faithful choice, not a gap).
 */

import { requestStorageGrant } from './cas-grant.js';
import { S3ObjectStore } from './s3-store.js';
import {
  BackupProviderError,
  type AccountStatus,
  type BackupProvider,
  type ProviderCapabilities,
  type S3Grant,
  type SnapshotRegistration,
  type SnapshotRow,
  type StoreClass,
  type TargetInfo,
  type Usage,
  type UsageByStore,
} from './provider.js';
import type { ObjectStore } from './object-store.js';
import { callProviderRoute } from './wire-client.js';

const DEFAULT_GRANT_TTL_SECONDS = 3600;

export interface RemoteBackupProviderOptions {
  /** e.g. "https://api.clawgnition.com" — no trailing slash required. */
  baseUrl: string;
  apiKey: string;
  /** Injectable for tests (the fake gateway server). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Credential grant TTL requested on `openDataPlane`. */
  grantTtlSeconds?: number;
}

export class RemoteBackupProvider implements BackupProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly grantTtlSeconds: number;

  constructor(options: RemoteBackupProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.grantTtlSeconds = options.grantTtlSeconds ?? DEFAULT_GRANT_TTL_SECONDS;
  }

  private call<T>(method: string, routePath: string, body?: unknown): Promise<T> {
    return callProviderRoute<T>(
      { baseUrl: this.baseUrl, apiKey: this.apiKey, fetchImpl: this.fetchImpl },
      method,
      routePath,
      body,
    );
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return this.call<ProviderCapabilities>('GET', '/v1/backup/provider');
  }

  async createTarget(opts: { label: string }): Promise<{ targetId: string }> {
    const row = await this.call<{ id: string }>('POST', '/v1/backup/vaults', { name: opts.label });
    return { targetId: row.id };
  }

  async deleteTarget(targetId: string): Promise<void> {
    await this.call<unknown>('DELETE', `/v1/backup/vaults/${encodeURIComponent(targetId)}`);
  }

  async undeleteTarget(targetId: string): Promise<void> {
    await this.call<unknown>('POST', `/v1/backup/vaults/${encodeURIComponent(targetId)}/undelete`);
  }

  async purgeTarget(targetId: string): Promise<void> {
    // The api-key tier this provider authenticates with MUST get a 403 here
    // (PROTOCOL.md § Auth) — `call` surfaces that as a normal thrown
    // BackupProviderError('interactive_auth_required'); there is no
    // client-side special case, the server enforces the tier.
    await this.call<unknown>('POST', `/v1/backup/vaults/${encodeURIComponent(targetId)}/purge`);
  }

  async requestGrant(
    targetId: string,
    store: StoreClass,
    mode: 'read' | 'read-write',
    ttlSeconds?: number,
  ): Promise<S3Grant> {
    return requestStorageGrant({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      fetchImpl: this.fetchImpl,
      targetId,
      store,
      mode,
      ttlSeconds: ttlSeconds ?? this.grantTtlSeconds,
    });
  }

  async openDataPlane(
    targetId: string,
    store: StoreClass,
    mode: 'read' | 'read-write',
  ): Promise<ObjectStore> {
    const grant = await this.requestGrant(targetId, store, mode);
    return new S3ObjectStore(grant, { refreshGrant: () => this.requestGrant(targetId, store, mode) });
  }

  async registerSnapshot(targetId: string, reg: SnapshotRegistration): Promise<SnapshotRow> {
    return this.call<SnapshotRow>(
      'POST',
      `/v1/backup/vaults/${encodeURIComponent(targetId)}/snapshots`,
      reg,
    );
  }

  async listSnapshots(
    targetId: string,
    opts?: { includePruned?: boolean },
  ): Promise<SnapshotRow[]> {
    const qs = opts?.includePruned ? '?includePruned=1' : '';
    return this.call<SnapshotRow[]>(
      'GET',
      `/v1/backup/vaults/${encodeURIComponent(targetId)}/snapshots${qs}`,
    );
  }

  async getSnapshot(targetId: string, seq: number): Promise<SnapshotRow> {
    return this.call<SnapshotRow>(
      'GET',
      `/v1/backup/vaults/${encodeURIComponent(targetId)}/snapshots/${seq}`,
    );
  }

  private async findTargetRow(targetId: string): Promise<{
    id: string;
    name: string;
    status: string;
    currentGeneration: number;
    usage: Usage;
  }> {
    const listing = await this.call<{
      accountStatus: AccountStatus;
      vaults: {
        id: string;
        name: string;
        status: string;
        currentGeneration: number;
        usage: Usage;
      }[];
    }>('GET', '/v1/backup/vaults');
    const row = listing.vaults.find((v) => v.id === targetId);
    if (!row) throw BackupProviderError.of('not_found', `unknown target "${targetId}"`);
    return row;
  }

  async getTarget(targetId: string): Promise<TargetInfo> {
    const row = await this.findTargetRow(targetId);
    return {
      id: row.id,
      name: row.name,
      status: row.status === 'active' ? 'active' : 'deleted',
      currentGeneration: row.currentGeneration,
      usage: row.usage,
    };
  }

  async usage(targetId: string): Promise<{ usage: Usage; accountStatus: AccountStatus }> {
    const listing = await this.call<{
      accountStatus: AccountStatus;
      vaults: { id: string; usage: Usage }[];
    }>('GET', '/v1/backup/vaults');
    const row = listing.vaults.find((v) => v.id === targetId);
    if (!row) throw BackupProviderError.of('not_found', `unknown target "${targetId}"`);
    return { usage: row.usage, accountStatus: listing.accountStatus };
  }

  async usageReport(targetId: string): Promise<UsageByStore> {
    return this.call<UsageByStore>(
      'GET',
      `/v1/backup/vaults/${encodeURIComponent(targetId)}/usage`,
    );
  }
}

export function openRemoteBackupProvider(
  options: RemoteBackupProviderOptions,
): RemoteBackupProvider {
  return new RemoteBackupProvider(options);
}
