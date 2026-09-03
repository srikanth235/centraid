import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { emptyRegistry } from "./local-provider-registry.js";
import type { Registry, RegistryTarget } from "./local-provider-registry.js";
import { FsObjectStore } from "./object-store.js";
import type { ObjectStore } from "./object-store.js";
import {
  inventoryFromFilesystem,
  paginateAuditEvents,
  validateProviderPolicy,
} from "./provider-observability.js";
import { BackupProviderError, STORE_CLASSES } from "./provider.js";
import type {
  AccountStatus,
  BackupProvider,
  ProviderAuditPage,
  ProviderAuditQuery,
  ProviderCapabilities,
  ProviderEventKind,
  ProviderInventoryPage,
  ProviderInventoryQuery,
  ProviderPolicy,
  ProviderPolicyDeclaration,
  SnapshotRegistration,
  SnapshotRow,
  StoreClass,
  StoreUsageReport,
  TargetInfo,
  Usage,
  UsageByStore,
} from "./provider.js";

const SOFT_DELETE_WINDOW_DAYS = 14;
const CAPABILITIES: ProviderCapabilities = {
  protocol: ["centraid-storage-provider/1"],
  dataPlane: "s3",
  capabilities: [
    "backup",
    "cas",
    "derived",
    "usage",
    "policy",
    "inventory",
    "audit",
  ],
  maxCredentialTtlSeconds: 86400,
  purgeAuthTier: "api-key",
  backup: {
    softDeleteWindowDays: SOFT_DELETE_WINDOW_DAYS,
    retention: { kind: "none" },
    restoreCostClass: "free-egress",
    objectLock: false,
    conditionalWrites: true,
  },
};

/* oxlint-disable max-classes-per-file -- (#354) the read-only wrapper is a small
   adapter colocated with the provider it serves (#247 convention). */
class ReadOnlyObjectStore implements ObjectStore {
  constructor(private readonly inner: ObjectStore) {}
  async put(): Promise<void> {
    throw new Error("object store opened in read-only mode; put refused");
  }
  get(key: string): Promise<Uint8Array> {
    return this.inner.get(key);
  }
  getStream(key: string): AsyncIterable<Uint8Array> {
    return this.inner.getStream(key);
  }
  head(key: string): Promise<{ size: number } | null> {
    return this.inner.head(key);
  }
  list(prefix: string): AsyncIterable<{ key: string; size: number }> {
    return this.inner.list(prefix);
  }
  async delete(): Promise<void> {
    throw new Error("object store opened in read-only mode; delete refused");
  }
}

export interface LocalBackupProviderOptions {
  rootDir: string;
}

export class LocalBackupProvider implements BackupProvider {
  private readonly rootDir: string;
  private readonly registryFile: string;
  private readonly objectsRoot: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: LocalBackupProviderOptions) {
    this.rootDir = options.rootDir;
    this.registryFile = path.join(this.rootDir, "registry.json");
    this.objectsRoot = path.join(this.rootDir, "objects");
  }

  private async load(): Promise<Registry> {
    try {
      const raw = await fs.readFile(this.registryFile, "utf8");
      const parsed = JSON.parse(raw) as Registry;
      return {
        targets: parsed.targets ?? {},
        snapshots: parsed.snapshots ?? {},
        idempotency: parsed.idempotency ?? {},
        nextSeq: parsed.nextSeq ?? {},
        policies: parsed.policies ?? {},
        events: parsed.events ?? {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return emptyRegistry();
    }
  }

  private async persist(registry: Registry): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(this.rootDir, { recursive: true });
      const tmp = `${this.registryFile}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify(registry, null, 2)}\n`, {
        mode: 0o600,
      });
      await fs.rename(tmp, this.registryFile);
    });
    await this.writeChain;
  }

  private requireTargetIn(
    registry: Registry,
    targetId: string
  ): RegistryTarget {
    const target = registry.targets[targetId];
    if (!target)
      throw BackupProviderError.of("not_found", `unknown target "${targetId}"`);
    return target;
  }

  private appendEvent(
    registry: Registry,
    targetId: string,
    kind: ProviderEventKind,
    detail: Record<string, unknown>
  ): void {
    (registry.events[targetId] ??= []).push({
      at: Math.floor(Date.now() / 1000),
      kind,
      detail,
    });
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return CAPABILITIES;
  }

  async createTarget(opts: { label: string }): Promise<{ targetId: string }> {
    const registry = await this.load();
    const id = randomUUID();
    registry.targets[id] = {
      id,
      name: opts.label,
      status: "active",
      currentGeneration: 0,
      createdAt: new Date().toISOString(),
      deletedAt: null,
      purgedAt: null,
    };
    registry.snapshots[id] = [];
    registry.idempotency[id] = {};
    registry.nextSeq[id] = 1;
    registry.events[id] = [];
    await persistObjectsDir(this.objectsRoot, id);
    await this.persist(registry);
    return { targetId: id };
  }

  async deleteTarget(targetId: string): Promise<void> {
    const registry = await this.load();
    const target = this.requireTargetIn(registry, targetId);
    if (target.purgedAt)
      throw BackupProviderError.of(
        "purge_pending",
        `target "${targetId}" was purged`
      );
    target.status = "deleted";
    target.deletedAt = new Date().toISOString();
    this.appendEvent(registry, targetId, "soft-delete", { targetId });
    await this.persist(registry);
  }

  async undeleteTarget(targetId: string): Promise<void> {
    const registry = await this.load();
    const target = this.requireTargetIn(registry, targetId);
    if (target.purgedAt) {
      throw BackupProviderError.of(
        "undelete_window_expired",
        `target "${targetId}" was purged — undelete is gone forever`
      );
    }
    if (!target.deletedAt) {
      target.status = "active";
      await this.persist(registry);
      return;
    }
    const deletedAt = new Date(target.deletedAt).getTime();
    const windowMs = SOFT_DELETE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    if (Date.now() - deletedAt > windowMs) {
      throw BackupProviderError.of(
        "undelete_window_expired",
        `target "${targetId}" was deleted more than ${SOFT_DELETE_WINDOW_DAYS} days ago`
      );
    }
    target.status = "active";
    target.deletedAt = null;
    this.appendEvent(registry, targetId, "undelete", { targetId });
    await this.persist(registry);
  }

  async purgeTarget(targetId: string): Promise<void> {
    const registry = await this.load();
    const target = this.requireTargetIn(registry, targetId);
    await fs.rm(path.join(this.objectsRoot, targetId), {
      recursive: true,
      force: true,
    });
    registry.snapshots[targetId] = [];
    registry.idempotency[targetId] = {};
    target.status = "deleted";
    target.deletedAt ??= new Date().toISOString();
    target.purgedAt = new Date().toISOString();
    this.appendEvent(registry, targetId, "purge", { targetId });
    await this.persist(registry);
  }

  private storeRoot(targetId: string, store: StoreClass): string {
    return path.join(this.objectsRoot, targetId, store);
  }

  async openDataPlane(
    targetId: string,
    store: StoreClass,
    mode: "read" | "read-write"
  ): Promise<ObjectStore> {
    const registry = await this.load();
    const target = this.requireTargetIn(registry, targetId);
    if (target.purgedAt)
      throw BackupProviderError.of(
        "purge_pending",
        `target "${targetId}" was purged`
      );
    const root = this.storeRoot(targetId, store);
    await fs.mkdir(root, { recursive: true });
    const fsStore = new FsObjectStore(root);
    return mode === "read" ? new ReadOnlyObjectStore(fsStore) : fsStore;
  }

  async registerSnapshot(
    targetId: string,
    reg: SnapshotRegistration
  ): Promise<SnapshotRow> {
    const registry = await this.load();
    const target = this.requireTargetIn(registry, targetId);
    if (target.purgedAt)
      throw BackupProviderError.of(
        "purge_pending",
        `target "${targetId}" was purged`
      );

    const existing = registry.idempotency[targetId]?.[reg.idempotencyKey];
    if (existing) return existing;

    if (reg.generation < target.currentGeneration) {
      throw BackupProviderError.of(
        "conflict_generation",
        `generation ${reg.generation} is stale`,
        {
          currentGeneration: target.currentGeneration,
        }
      );
    }

    const rows = (registry.snapshots[targetId] ??= []);
    const prevManifestHash = rows[0]?.manifestHash ?? null;
    const seq = registry.nextSeq[targetId] ?? 1;
    registry.nextSeq[targetId] = seq + 1;
    const row: SnapshotRow = {
      seq,
      manifestKey: reg.manifestKey,
      manifestHash: reg.manifestHash,
      prevManifestHash,
      totalBytes: reg.totalBytes,
      objectCount: reg.objectCount,
      generation: reg.generation,
      format: reg.format,
      appMeta: reg.appMeta,
      createdAt: Math.floor(Date.now() / 1000),
      prunedAt: null,
    };
    rows.unshift(row);
    target.currentGeneration = Math.max(
      target.currentGeneration,
      reg.generation
    );
    (registry.idempotency[targetId] ??= {})[reg.idempotencyKey] = row;
    await this.persist(registry);
    return row;
  }

  async listSnapshots(
    targetId: string,
    opts?: { includePruned?: boolean }
  ): Promise<SnapshotRow[]> {
    const registry = await this.load();
    this.requireTargetIn(registry, targetId);
    const rows = registry.snapshots[targetId] ?? [];
    return opts?.includePruned
      ? [...rows]
      : rows.filter((r) => r.prunedAt === null);
  }

  async getSnapshot(targetId: string, seq: number): Promise<SnapshotRow> {
    const registry = await this.load();
    this.requireTargetIn(registry, targetId);
    const row = (registry.snapshots[targetId] ?? []).find((r) => r.seq === seq);
    if (!row)
      throw BackupProviderError.of(
        "not_found",
        `unknown snapshot seq ${seq} for target "${targetId}"`
      );
    return row;
  }

  async getTarget(targetId: string): Promise<TargetInfo> {
    const registry = await this.load();
    const target = this.requireTargetIn(registry, targetId);
    const { usage } = await this.usage(targetId);
    return {
      id: target.id,
      name: target.name,
      status: target.status,
      currentGeneration: target.currentGeneration,
      usage,
    };
  }

  async usage(
    targetId: string
  ): Promise<{ usage: Usage; accountStatus: AccountStatus }> {
    const registry = await this.load();
    this.requireTargetIn(registry, targetId);
    const { bytesStored, objectCount } = await this.countStore(
      targetId,
      "backup"
    );
    return {
      usage: {
        storedBytes: bytesStored,
        objectCount,
        meteredAt: Math.floor(Date.now() / 1000),
      },
      accountStatus: "ok",
    };
  }

  private async countStore(
    targetId: string,
    store: StoreClass
  ): Promise<{ bytesStored: number; objectCount: number }> {
    const fsStore = new FsObjectStore(this.storeRoot(targetId, store));
    let bytesStored = 0;
    let objectCount = 0;
    for await (const obj of fsStore.list("")) {
      bytesStored += obj.size;
      objectCount++;
    }
    return { bytesStored, objectCount };
  }

  async usageReport(targetId: string): Promise<UsageByStore> {
    const registry = await this.load();
    const target = this.requireTargetIn(registry, targetId);
    const start = Math.floor(new Date(target.createdAt).getTime() / 1000);
    const end = Math.floor(Date.now() / 1000);
    const reports = await Promise.all(
      STORE_CLASSES.map(async (store) => {
        const { bytesStored, objectCount } = await this.countStore(
          targetId,
          store
        );
        const report: StoreUsageReport = {
          bytesStored,
          objectCount,
          quotaBytes: null,
          period: { start, end },
        };
        return [store, report] as const;
      })
    );
    const out: UsageByStore = Object.fromEntries(reports);
    return out;
  }

  async putPolicy(
    targetId: string,
    input: ProviderPolicyDeclaration
  ): Promise<ProviderPolicy> {
    const registry = await this.load();
    this.requireTargetIn(registry, targetId);
    const policy = {
      ...validateProviderPolicy(input),
      declaredAt: Math.floor(Date.now() / 1000),
    };
    registry.policies[targetId] = policy;
    this.appendEvent(registry, targetId, "policy-changed", { policy });
    await this.persist(registry);
    return policy;
  }

  async getPolicy(targetId: string): Promise<ProviderPolicy> {
    const registry = await this.load();
    this.requireTargetIn(registry, targetId);
    const policy = registry.policies[targetId];
    if (!policy)
      throw BackupProviderError.of(
        "not_found",
        `no policy for target "${targetId}"`
      );
    return policy;
  }

  async listInventory(
    targetId: string,
    query: ProviderInventoryQuery
  ): Promise<ProviderInventoryPage> {
    const registry = await this.load();
    const target = this.requireTargetIn(registry, targetId);
    return inventoryFromFilesystem(
      this.storeRoot(targetId, query.store),
      target.status === "active" ? "live" : "soft-deleted",
      query
    );
  }

  async listEvents(
    targetId: string,
    query?: ProviderAuditQuery
  ): Promise<ProviderAuditPage> {
    const registry = await this.load();
    this.requireTargetIn(registry, targetId);
    return paginateAuditEvents(registry.events[targetId] ?? [], query);
  }
}

async function persistObjectsDir(
  objectsRoot: string,
  targetId: string
): Promise<void> {
  await fs.mkdir(path.join(objectsRoot, targetId), { recursive: true });
}

export function openLocalBackupProvider(
  options: LocalBackupProviderOptions
): LocalBackupProvider {
  return new LocalBackupProvider(options);
}
