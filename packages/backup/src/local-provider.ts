/*
 * `LocalBackupProvider` — a `BackupProvider` backed entirely by the local
 * filesystem: `objects/<targetId>/` (an `FsObjectStore` per target) plus a
 * `registry.json` tracking targets, snapshots and generations. Exists for
 * two reasons: (1) "backup to an external drive / NAS" is a real product
 * mode, not just a test fixture, and (2) `conformance.ts` needs a reference
 * implementation to run against in this package's own test suite.
 *
 * Auth tiers here (PROTOCOL.md): the local disk *is* the user's own
 * api-key-equivalent custody, so `purgeAuthTier: 'api-key'` and
 * `purgeTarget` succeeds directly — there's no separate "interactive"
 * surface to defer to when the surface already IS the user's machine.
 *
 * Cross-process correctness (the whole point of generation fencing —
 * PROTOCOL.md: "two gateways, one vault"): `registry.json` is re-read from
 * disk on EVERY operation. There is deliberately no in-memory cache — a
 * cache keyed by mtime was considered and rejected, because these files are
 * small (a handful of KB per target) and a stale read here is exactly the
 * bug generation fencing exists to catch. Each public method loads the
 * registry once, mutates that single in-memory copy, and persists that
 * SAME object — never a second independent read — so a method never loses
 * its own mutations to an interleaved re-read.
 *
 * Honest TOCTOU window: nothing below serializes read-modify-write ACROSS
 * operations or processes. Two `registerSnapshot` calls — same or
 * different processes — that both read the registry before either writes
 * can both compute (e.g.) the same `nextSeq`; the second `persist()` wins
 * and the first's row is silently gone from the registry. This is
 * explicitly out of scope for a JSON-file provider: `persist()`'s
 * temp-file-then-rename keeps `registry.json` itself always well-formed
 * (a crash mid-write never corrupts it), but does not arbitrate concurrent
 * writers. Single-writer-per-operation is the deployment assumption — a
 * real multi-writer NAS-sharing story needs a lock file or a real backend,
 * neither of which this reference implementation attempts.
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FsObjectStore, type ObjectStore } from './object-store.js';
import {
  inventoryFromFilesystem,
  paginateAuditEvents,
  validateProviderPolicy,
} from './provider-observability.js';
import {
  BackupProviderError,
  type AccountStatus,
  type BackupProvider,
  type ProviderAuditEvent,
  type ProviderAuditPage,
  type ProviderAuditQuery,
  type ProviderCapabilities,
  type ProviderEventKind,
  type ProviderInventoryPage,
  type ProviderInventoryQuery,
  type ProviderPolicy,
  type ProviderPolicyDeclaration,
  type SnapshotRegistration,
  type SnapshotRow,
  type StoreClass,
  type StoreUsageReport,
  type TargetInfo,
  type Usage,
  type UsageByStore,
} from './provider.js';

interface RegistryTarget {
  id: string;
  name: string;
  status: 'active' | 'deleted';
  currentGeneration: number;
  createdAt: string;
  deletedAt: string | null;
  purgedAt: string | null;
}

interface Registry {
  targets: Record<string, RegistryTarget>;
  snapshots: Record<string, SnapshotRow[]>;
  idempotency: Record<string, Record<string, SnapshotRow>>;
  nextSeq: Record<string, number>;
  policies: Record<string, ProviderPolicy>;
  events: Record<string, ProviderAuditEvent[]>;
}

function emptyRegistry(): Registry {
  return { targets: {}, snapshots: {}, idempotency: {}, nextSeq: {}, policies: {}, events: {} };
}

const SOFT_DELETE_WINDOW_DAYS = 14;
const CAPABILITIES: ProviderCapabilities = {
  protocol: ['centraid-storage-provider/1'],
  dataPlane: 's3',
  // Local disk has no separate wire-grant concept (openDataPlane IS the
  // grant), but it still supports both store classes and can report cheap,
  // real usage — all three are legitimately advertised offline.
  capabilities: ['backup', 'cas', 'usage', 'policy', 'inventory', 'audit'],
  maxCredentialTtlSeconds: 86400,
  purgeAuthTier: 'api-key',
  backup: {
    softDeleteWindowDays: SOFT_DELETE_WINDOW_DAYS,
    retention: { kind: 'none' },
    restoreCostClass: 'free-egress',
    objectLock: false,
    conditionalWrites: true,
  },
};

/* eslint-disable max-classes-per-file -- (#354) the read-only wrapper is a small
   adapter colocated with the provider it serves (#247 convention). */
/** Read-only wrapper: `put`/`delete` refused, everything else passes through. */
class ReadOnlyObjectStore implements ObjectStore {
  constructor(private readonly inner: ObjectStore) {}
  async put(): Promise<void> {
    throw new Error('object store opened in read-only mode; put refused');
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
    throw new Error('object store opened in read-only mode; delete refused');
  }
}

export interface LocalBackupProviderOptions {
  /** Root directory: holds `objects/` and `registry.json`. */
  rootDir: string;
}

export class LocalBackupProvider implements BackupProvider {
  private readonly rootDir: string;
  private readonly registryFile: string;
  private readonly objectsRoot: string;
  /** Serializes the temp-file-then-rename write itself (not read-modify-write; see module header). */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: LocalBackupProviderOptions) {
    this.rootDir = options.rootDir;
    this.registryFile = path.join(this.rootDir, 'registry.json');
    this.objectsRoot = path.join(this.rootDir, 'objects');
  }

  /**
   * Always re-reads `registry.json` from disk — no in-memory cache (module
   * header). Every public method calls this exactly once and threads the
   * returned object through to its own `persist()` call, so a method's own
   * mutations are never lost to a second, independent load.
   */
  private async load(): Promise<Registry> {
    try {
      const raw = await fs.readFile(this.registryFile, 'utf8');
      const parsed = JSON.parse(raw) as Registry;
      return {
        targets: parsed.targets ?? {},
        snapshots: parsed.snapshots ?? {},
        idempotency: parsed.idempotency ?? {},
        nextSeq: parsed.nextSeq ?? {},
        policies: parsed.policies ?? {},
        events: parsed.events ?? {},
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      return emptyRegistry();
    }
  }

  /** Persist the given (already-mutated) registry atomically. */
  private async persist(registry: Registry): Promise<void> {
    // Serialize the writes THIS instance issues so two of its own in-flight
    // persist() calls don't race on the temp-file rename. Does not — and
    // cannot — serialize against another process; see the module header.
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(this.rootDir, { recursive: true });
      const tmp = `${this.registryFile}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(tmp, this.registryFile);
    });
    await this.writeChain;
  }

  private requireTargetIn(registry: Registry, targetId: string): RegistryTarget {
    const target = registry.targets[targetId];
    if (!target) throw BackupProviderError.of('not_found', `unknown target "${targetId}"`);
    return target;
  }

  private appendEvent(
    registry: Registry,
    targetId: string,
    kind: ProviderEventKind,
    detail: Record<string, unknown>,
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
      status: 'active',
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
      throw BackupProviderError.of('purge_pending', `target "${targetId}" was purged`);
    target.status = 'deleted';
    target.deletedAt = new Date().toISOString();
    this.appendEvent(registry, targetId, 'soft-delete', { targetId });
    await this.persist(registry);
  }

  async undeleteTarget(targetId: string): Promise<void> {
    const registry = await this.load();
    const target = this.requireTargetIn(registry, targetId);
    if (target.purgedAt) {
      throw BackupProviderError.of(
        'undelete_window_expired',
        `target "${targetId}" was purged — undelete is gone forever`,
      );
    }
    if (!target.deletedAt) {
      target.status = 'active';
      await this.persist(registry);
      return; // already active — undelete is a no-op
    }
    const deletedAt = new Date(target.deletedAt).getTime();
    const windowMs = SOFT_DELETE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    if (Date.now() - deletedAt > windowMs) {
      throw BackupProviderError.of(
        'undelete_window_expired',
        `target "${targetId}" was deleted more than ${SOFT_DELETE_WINDOW_DAYS} days ago`,
      );
    }
    target.status = 'active';
    target.deletedAt = null;
    this.appendEvent(registry, targetId, 'undelete', { targetId });
    await this.persist(registry);
  }

  async purgeTarget(targetId: string): Promise<void> {
    // Local disk IS the user's own custody — api-key tier suffices (see
    // module header). A remote provider MUST reject this with 403.
    const registry = await this.load();
    const target = this.requireTargetIn(registry, targetId);
    await fs.rm(path.join(this.objectsRoot, targetId), { recursive: true, force: true });
    registry.snapshots[targetId] = [];
    registry.idempotency[targetId] = {};
    target.status = 'deleted';
    target.deletedAt = target.deletedAt ?? new Date().toISOString();
    target.purgedAt = new Date().toISOString();
    this.appendEvent(registry, targetId, 'purge', { targetId });
    await this.persist(registry);
  }

  /** Per-store isolated root (PROTOCOL.md § Layer 1 — per-store isolated
   *  prefixes): `objects/<targetId>/<store>/`, giving `backup` and `cas`
   *  disjoint namespaces without a literal wire grant. */
  private storeRoot(targetId: string, store: StoreClass): string {
    return path.join(this.objectsRoot, targetId, store);
  }

  async openDataPlane(
    targetId: string,
    store: StoreClass,
    mode: 'read' | 'read-write',
  ): Promise<ObjectStore> {
    const registry = await this.load();
    const target = this.requireTargetIn(registry, targetId);
    if (target.purgedAt)
      throw BackupProviderError.of('purge_pending', `target "${targetId}" was purged`);
    const root = this.storeRoot(targetId, store);
    await fs.mkdir(root, { recursive: true });
    const fsStore = new FsObjectStore(root);
    return mode === 'read' ? new ReadOnlyObjectStore(fsStore) : fsStore;
  }

  async registerSnapshot(targetId: string, reg: SnapshotRegistration): Promise<SnapshotRow> {
    const registry = await this.load();
    const target = this.requireTargetIn(registry, targetId);
    if (target.purgedAt)
      throw BackupProviderError.of('purge_pending', `target "${targetId}" was purged`);

    // Idempotency replay BEFORE the fencing check (spec-mandated order).
    const existing = registry.idempotency[targetId]?.[reg.idempotencyKey];
    if (existing) return existing;

    if (reg.generation < target.currentGeneration) {
      throw BackupProviderError.of('conflict_generation', `generation ${reg.generation} is stale`, {
        currentGeneration: target.currentGeneration,
      });
    }

    const rows = registry.snapshots[targetId] ?? (registry.snapshots[targetId] = []);
    const prevManifestHash = rows[0]?.manifestHash ?? null; // newest-first
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
      createdAt: Math.floor(Date.now() / 1000), // wire timestamps are epoch seconds
      prunedAt: null,
    };
    rows.unshift(row); // newest-first
    target.currentGeneration = Math.max(target.currentGeneration, reg.generation);
    (registry.idempotency[targetId] ?? (registry.idempotency[targetId] = {}))[reg.idempotencyKey] =
      row;
    await this.persist(registry);
    return row;
  }

  async listSnapshots(
    targetId: string,
    opts?: { includePruned?: boolean },
  ): Promise<SnapshotRow[]> {
    const registry = await this.load();
    this.requireTargetIn(registry, targetId);
    const rows = registry.snapshots[targetId] ?? [];
    return opts?.includePruned ? [...rows] : rows.filter((r) => r.prunedAt === null);
  }

  async getSnapshot(targetId: string, seq: number): Promise<SnapshotRow> {
    const registry = await this.load();
    this.requireTargetIn(registry, targetId);
    const row = (registry.snapshots[targetId] ?? []).find((r) => r.seq === seq);
    if (!row)
      throw BackupProviderError.of(
        'not_found',
        `unknown snapshot seq ${seq} for target "${targetId}"`,
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

  /** Backup store's own usage figure (Layer 2, embedded in the target list) —
   *  scoped to the `backup` subtree only; `cas` usage is reported separately
   *  via `usageReport`. */
  async usage(targetId: string): Promise<{ usage: Usage; accountStatus: AccountStatus }> {
    const registry = await this.load();
    this.requireTargetIn(registry, targetId);
    const { bytesStored, objectCount } = await this.countStore(targetId, 'backup');
    return {
      usage: {
        storedBytes: bytesStored,
        objectCount,
        // quotaBytes deliberately omitted — local disk has no product-declared
        // quota, and the field is optional on the wire (a provider may not cap).
        meteredAt: Math.floor(Date.now() / 1000), // epoch seconds
      },
      accountStatus: 'ok',
    };
  }

  private async countStore(
    targetId: string,
    store: StoreClass,
  ): Promise<{ bytesStored: number; objectCount: number }> {
    const fsStore = new FsObjectStore(this.storeRoot(targetId, store));
    let bytesStored = 0;
    let objectCount = 0;
    for await (const obj of fsStore.list('')) {
      bytesStored += obj.size;
      objectCount++;
    }
    return { bytesStored, objectCount };
  }

  /** Layer-1 `usage` capability — real byte counts, cheap to compute locally
   *  (PROTOCOL.md § Usage). `quotaBytes: null` (unmetered); `period` spans
   *  target creation to now (local disk has no billing-period concept). */
  async usageReport(targetId: string): Promise<UsageByStore> {
    const registry = await this.load();
    const target = this.requireTargetIn(registry, targetId);
    const start = Math.floor(new Date(target.createdAt).getTime() / 1000);
    const end = Math.floor(Date.now() / 1000);
    const out: UsageByStore = {};
    for (const store of ['backup', 'cas'] as const) {
      const { bytesStored, objectCount } = await this.countStore(targetId, store);
      const report: StoreUsageReport = {
        bytesStored,
        objectCount,
        quotaBytes: null,
        period: { start, end },
      };
      out[store] = report;
    }
    return out;
  }

  async putPolicy(targetId: string, input: ProviderPolicyDeclaration): Promise<ProviderPolicy> {
    const registry = await this.load();
    this.requireTargetIn(registry, targetId);
    const policy = { ...validateProviderPolicy(input), declaredAt: Math.floor(Date.now() / 1000) };
    registry.policies[targetId] = policy;
    this.appendEvent(registry, targetId, 'policy-changed', { policy });
    await this.persist(registry);
    return policy;
  }

  async getPolicy(targetId: string): Promise<ProviderPolicy> {
    const registry = await this.load();
    this.requireTargetIn(registry, targetId);
    const policy = registry.policies[targetId];
    if (!policy) throw BackupProviderError.of('not_found', `no policy for target "${targetId}"`);
    return policy;
  }

  async listInventory(
    targetId: string,
    query: ProviderInventoryQuery,
  ): Promise<ProviderInventoryPage> {
    const registry = await this.load();
    const target = this.requireTargetIn(registry, targetId);
    return inventoryFromFilesystem(
      this.storeRoot(targetId, query.store),
      target.status === 'active' ? 'live' : 'soft-deleted',
      query,
    );
  }

  async listEvents(targetId: string, query?: ProviderAuditQuery): Promise<ProviderAuditPage> {
    const registry = await this.load();
    this.requireTargetIn(registry, targetId);
    return paginateAuditEvents(registry.events[targetId] ?? [], query);
  }
}

async function persistObjectsDir(objectsRoot: string, targetId: string): Promise<void> {
  await fs.mkdir(path.join(objectsRoot, targetId), { recursive: true });
}

export function openLocalBackupProvider(options: LocalBackupProviderOptions): LocalBackupProvider {
  return new LocalBackupProvider(options);
}
