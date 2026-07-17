/* eslint-disable max-classes-per-file -- error and encrypted store form one persistence boundary (#408) */
/*
 * Gateway-level storage connection (issue #367 §C1, collapsed by #436 §2/§7):
 * ONE persisted entity — a base URL + a sealed api key — that BOTH the offsite
 * backup engine (`backup-config.ts`'s `BackupProviderConfig`) and a vault's CAS
 * remote tier (`BlobStoreSettings.connectionId`, `@centraid/vault`) point at.
 *
 * There is exactly one kind now: `provider` — a Centraid storage-provider
 * account (`centraid-storage-provider/1`, packages/backup/PROTOCOL.md). Real
 * data-plane credentials are short-lived grants (`requestCasGrant`), resolved
 * at use time (`storage-credentials.ts`) and never persisted here; only the
 * account api key is sealed at rest. The old `byo-s3` peer kind — static
 * S3-compatible credentials the owner supplied directly — is retired (#436 §2):
 * a home connection is always a managed provider bundle (snapshots + cas +
 * derived), and there is only ever ONE of them (#436 §7 — the home connection).
 *
 * Key custody: unlike a vault's DEK (one per vault, minted in a `keys/`
 * sibling of the vault directory — `@centraid/vault`'s `schema/sealed.ts`),
 * this is a GATEWAY-level secret: the connection is shared across the backup
 * engine and every mounted vault's CAS tier, so no single vault is the
 * natural custodian. A dedicated key file lives beside the connection itself
 * (`<dir>/connections.sealkey`, 0600) — same shape as a vault's sealkey
 * (`createSealKey`/`loadSealKey`), just scoped to the gateway process instead
 * of one vault. The sealing primitives themselves (`sealValue`, `unsealValue`,
 * `sealAad`) are the exact ones `@centraid/vault` already uses for sealed
 * columns — one AEAD envelope shape across the whole system.
 *
 * Persistence mirrors `backup-state.ts`: atomic JSON writes (temp + rename),
 * 0600, re-read on every mutating call so a concurrent admin CLI and the
 * live daemon never silently diverge.
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createSealKey, loadSealKey, sealAad, sealValue, unsealValue } from '@centraid/vault';

/** Retained as a single-member type so the wire `kind` field stays present
 *  (`provider`) for callers that still branch on it; there is no other kind. */
export type StorageConnectionKind = 'provider';

interface ProviderRow {
  id: string;
  kind: 'provider';
  name: string;
  createdAt: string;
  updatedAt: string;
  baseUrl: string;
  /** sealed JSON `{apiKey}`. */
  sealedCredentials: string;
  /** Provider-issued target id (issue #367 §C1), set once `ensureTarget` has run. */
  targetId?: string;
}

type StorageConnectionRow = ProviderRow;

interface StorageConnectionsFile {
  version: 1;
  connections: StorageConnectionRow[];
}

/** The public (never-secret) shape a route/UI reads — Section D consumes this. */
export interface StorageConnectionRecord {
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

export interface CreateProviderInput {
  kind: 'provider';
  name: string;
  baseUrl: string;
  apiKey: string;
}

export type CreateStorageConnectionInput = CreateProviderInput;
export type UpdateStorageConnectionInput = Partial<CreateProviderInput>;

export class StorageConnectionError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid_request' | 'already_exists' | 'provider_not_home_profile',
    message: string,
  ) {
    super(message);
    this.name = 'StorageConnectionError';
  }
}

function connectionsFile(dir: string): string {
  return path.join(dir, 'connections.json');
}
function sealKeyFile(dir: string): string {
  return path.join(dir, 'connections.sealkey');
}

function toRecord(row: StorageConnectionRow): StorageConnectionRecord {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    baseUrl: row.baseUrl,
    ...(row.targetId ? { targetId: row.targetId } : {}),
  };
}

export class StorageConnectionStore {
  private rows: StorageConnectionRow[] = [];

  private constructor(
    private readonly file: string,
    private readonly key: Buffer,
  ) {}

  static async open(dir: string): Promise<StorageConnectionStore> {
    await fs.mkdir(dir, { recursive: true });
    const keyPath = sealKeyFile(dir);
    // Same "load-or-mint" custody shape as a vault's DEK, scoped to the
    // gateway instead — see the module header for why this can't just BE a
    // vault's key (the connection outlives, and is shared across, any one vault).
    const key = loadSealKey(keyPath) ?? createSealKey(keyPath);
    const store = new StorageConnectionStore(connectionsFile(dir), key);
    await store.reload();
    return store;
  }

  private async reload(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StorageConnectionsFile>;
      this.rows = Array.isArray(parsed.connections)
        ? parsed.connections.filter((row): row is StorageConnectionRow => row.kind === 'provider')
        : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      this.rows = [];
    }
  }

  private async persist(): Promise<void> {
    const payload: StorageConnectionsFile = { version: 1, connections: this.rows };
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  async list(): Promise<StorageConnectionRecord[]> {
    await this.reload();
    return this.rows.map(toRecord);
  }

  async get(id: string): Promise<StorageConnectionRecord | undefined> {
    await this.reload();
    const row = this.rows.find((r) => r.id === id);
    return row ? toRecord(row) : undefined;
  }

  private requireRow(id: string): StorageConnectionRow {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new StorageConnectionError('not_found', `unknown storage connection "${id}"`);
    return row;
  }

  async create(input: CreateStorageConnectionInput): Promise<StorageConnectionRecord> {
    await this.reload();
    if (!input.name || input.name.trim().length === 0) {
      throw new StorageConnectionError('invalid_request', 'name is required');
    }
    if (input.kind !== 'provider') {
      throw new StorageConnectionError('invalid_request', 'kind must be "provider"');
    }
    if (!input.baseUrl || !input.apiKey) {
      throw new StorageConnectionError('invalid_request', 'provider requires baseUrl and apiKey');
    }
    // Exactly one home connection at a time (issue #436 §7): a provider
    // connection is a full home bundle (snapshots + cas + derived), so a
    // second one has no meaning — reject rather than silently pick.
    if (this.rows.length > 0) {
      throw new StorageConnectionError(
        'already_exists',
        'a storage connection already exists — only one home connection can be active at a time; delete it before adding another',
      );
    }
    const id = randomBytes(12).toString('hex');
    const now = new Date().toISOString();
    const row: StorageConnectionRow = {
      id,
      kind: 'provider',
      name: input.name,
      createdAt: now,
      updatedAt: now,
      baseUrl: input.baseUrl,
      sealedCredentials: this.sealCreds(id, { apiKey: input.apiKey }),
    };
    this.rows.push(row);
    await this.persist();
    return toRecord(row);
  }

  /**
   * Rotation (issue #367 §C9): changing `baseUrl` is exactly this method —
   * nothing here migrates any vault's custody rows. `storage-routes.ts`
   * propagates the new endpoint/bucket into every referencing vault's
   * `blob_store` settings, which is what actually flips `db.ts`'s
   * `remoteTier()` cache key and starts custody over (see that module's
   * header for why that's enough).
   */
  async update(id: string, patch: UpdateStorageConnectionInput): Promise<StorageConnectionRecord> {
    await this.reload();
    const row = this.requireRow(id);
    const now = new Date().toISOString();
    if (patch.kind && patch.kind !== 'provider') {
      throw new StorageConnectionError('invalid_request', "cannot change a connection's kind");
    }
    if (patch.baseUrl) row.baseUrl = patch.baseUrl;
    if (patch.name) row.name = patch.name;
    if (patch.apiKey) row.sealedCredentials = this.sealCreds(id, { apiKey: patch.apiKey });
    row.updatedAt = now;
    await this.persist();
    return toRecord(row);
  }

  /** Stamp the provider-issued target id once a target has been created (issue #367 §C1/§C10). */
  async setTargetId(id: string, targetId: string): Promise<StorageConnectionRecord> {
    await this.reload();
    const row = this.requireRow(id);
    row.targetId = targetId;
    row.updatedAt = new Date().toISOString();
    await this.persist();
    return toRecord(row);
  }

  async delete(id: string): Promise<void> {
    await this.reload();
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.id !== id);
    if (this.rows.length === before) {
      throw new StorageConnectionError('not_found', `unknown storage connection "${id}"`);
    }
    await this.persist();
  }

  /** Resolve the provider api key for a connection (issue #367 §C3). */
  async resolveProviderApiKey(id: string): Promise<string> {
    await this.reload();
    const row = this.requireRow(id);
    const creds = this.unsealCreds(id, row.sealedCredentials) as { apiKey: string };
    return creds.apiKey;
  }

  private sealCreds(id: string, value: Record<string, unknown>): string {
    return sealValue(
      this.key,
      sealAad('storage_connection', 'credentials', id),
      JSON.stringify(value),
    );
  }

  private unsealCreds(id: string, sealed: string): Record<string, unknown> {
    return JSON.parse(
      unsealValue(this.key, sealAad('storage_connection', 'credentials', id), sealed),
    ) as Record<string, unknown>;
  }
}

export function openStorageConnectionStore(dir: string): Promise<StorageConnectionStore> {
  return StorageConnectionStore.open(dir);
}
