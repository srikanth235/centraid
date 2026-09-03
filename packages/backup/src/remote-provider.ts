import { requestStorageGrant } from "./cas-grant.js";
import type { ObjectStore } from "./object-store.js";
import { BackupProviderError } from "./provider.js";
import type {
  AccountStatus,
  BackupProvider,
  ProviderAuditPage,
  ProviderAuditQuery,
  ProviderCapabilities,
  ProviderInventoryPage,
  ProviderInventoryQuery,
  ProviderPolicy,
  ProviderPolicyDeclaration,
  S3Grant,
  SnapshotRegistration,
  SnapshotRow,
  StoreClass,
  TargetInfo,
  Usage,
  UsageByStore,
} from "./provider.js";
import { S3ObjectStore } from "./s3-store.js";
import { callProviderRoute } from "./wire-client.js";

const DEFAULT_GRANT_TTL_SECONDS = 3600;

function appendQuery(
  route: string,
  query: Record<string, string | number | undefined>
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `${route}?${encoded}` : route;
}

export interface RemoteBackupProviderOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  grantTtlSeconds?: number;
}

export class RemoteBackupProvider implements BackupProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly grantTtlSeconds: number;

  constructor(options: RemoteBackupProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/u, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.grantTtlSeconds = options.grantTtlSeconds ?? DEFAULT_GRANT_TTL_SECONDS;
  }

  private call<T>(
    method: string,
    routePath: string,
    body?: unknown
  ): Promise<T> {
    return callProviderRoute<T>(
      { baseUrl: this.baseUrl, apiKey: this.apiKey, fetchImpl: this.fetchImpl },
      method,
      routePath,
      body
    );
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return this.call<ProviderCapabilities>("GET", "/v1/storage/provider");
  }

  async createTarget(opts: { label: string }): Promise<{ targetId: string }> {
    const row = await this.call<{ id: string }>("POST", "/v1/storage/vaults", {
      name: opts.label,
    });
    return { targetId: row.id };
  }

  async deleteTarget(targetId: string): Promise<void> {
    await this.call<unknown>(
      "DELETE",
      `/v1/storage/vaults/${encodeURIComponent(targetId)}`
    );
  }

  async undeleteTarget(targetId: string): Promise<void> {
    await this.call<unknown>(
      "POST",
      `/v1/storage/vaults/${encodeURIComponent(targetId)}/undelete`
    );
  }

  async purgeTarget(targetId: string): Promise<void> {
    await this.call<unknown>(
      "POST",
      `/v1/storage/vaults/${encodeURIComponent(targetId)}/purge`
    );
  }

  async requestGrant(
    targetId: string,
    store: StoreClass,
    mode: "read" | "read-write",
    ttlSeconds?: number
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
    mode: "read" | "read-write"
  ): Promise<ObjectStore> {
    const grant = await this.requestGrant(targetId, store, mode);
    return new S3ObjectStore(grant, {
      refreshGrant: () => this.requestGrant(targetId, store, mode),
    });
  }

  async registerSnapshot(
    targetId: string,
    reg: SnapshotRegistration
  ): Promise<SnapshotRow> {
    return this.call<SnapshotRow>(
      "POST",
      `/v1/storage/vaults/${encodeURIComponent(targetId)}/snapshots`,
      reg
    );
  }

  async listSnapshots(
    targetId: string,
    opts?: { includePruned?: boolean }
  ): Promise<SnapshotRow[]> {
    const qs = opts?.includePruned ? "?includePruned=1" : "";
    return this.call<SnapshotRow[]>(
      "GET",
      `/v1/storage/vaults/${encodeURIComponent(targetId)}/snapshots${qs}`
    );
  }

  async getSnapshot(targetId: string, seq: number): Promise<SnapshotRow> {
    return this.call<SnapshotRow>(
      "GET",
      `/v1/storage/vaults/${encodeURIComponent(targetId)}/snapshots/${seq}`
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
    }>("GET", "/v1/storage/vaults");
    const row = listing.vaults.find((v) => v.id === targetId);
    if (!row)
      throw BackupProviderError.of("not_found", `unknown target "${targetId}"`);
    return row;
  }

  async getTarget(targetId: string): Promise<TargetInfo> {
    const row = await this.findTargetRow(targetId);
    return {
      id: row.id,
      name: row.name,
      status: row.status === "active" ? "active" : "deleted",
      currentGeneration: row.currentGeneration,
      usage: row.usage,
    };
  }

  async usage(
    targetId: string
  ): Promise<{ usage: Usage; accountStatus: AccountStatus }> {
    const listing = await this.call<{
      accountStatus: AccountStatus;
      vaults: { id: string; usage: Usage }[];
    }>("GET", "/v1/storage/vaults");
    const row = listing.vaults.find((v) => v.id === targetId);
    if (!row)
      throw BackupProviderError.of("not_found", `unknown target "${targetId}"`);
    return { usage: row.usage, accountStatus: listing.accountStatus };
  }

  async usageReport(targetId: string): Promise<UsageByStore> {
    return this.call<UsageByStore>(
      "GET",
      `/v1/storage/vaults/${encodeURIComponent(targetId)}/usage`
    );
  }

  async putPolicy(
    targetId: string,
    policy: ProviderPolicyDeclaration
  ): Promise<ProviderPolicy> {
    return this.call<ProviderPolicy>(
      "PUT",
      `/v1/storage/vaults/${encodeURIComponent(targetId)}/policy`,
      policy
    );
  }

  async getPolicy(targetId: string): Promise<ProviderPolicy> {
    return this.call<ProviderPolicy>(
      "GET",
      `/v1/storage/vaults/${encodeURIComponent(targetId)}/policy`
    );
  }

  async listInventory(
    targetId: string,
    query: ProviderInventoryQuery
  ): Promise<ProviderInventoryPage> {
    const route = appendQuery(
      `/v1/storage/vaults/${encodeURIComponent(targetId)}/inventory`,
      {
        store: query.store,
        cursor: query.cursor,
        since: query.since,
        limit: query.limit,
      }
    );
    return this.call<ProviderInventoryPage>("GET", route);
  }

  async listEvents(
    targetId: string,
    query: ProviderAuditQuery = {}
  ): Promise<ProviderAuditPage> {
    const route = appendQuery(
      `/v1/storage/vaults/${encodeURIComponent(targetId)}/events`,
      {
        cursor: query.cursor,
        since: query.since,
        limit: query.limit,
      }
    );
    return this.call<ProviderAuditPage>("GET", route);
  }
}

export function openRemoteBackupProvider(
  options: RemoteBackupProviderOptions
): RemoteBackupProvider {
  return new RemoteBackupProvider(options);
}
