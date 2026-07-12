/*
 * Gateway-level storage connections (issue #367 §C1): ONE persisted entity
 * — endpoint + region + bucket + a credential reference — that BOTH the
 * offsite backup engine (`backup-config.ts`'s `BackupProviderConfig`) and a
 * vault's CAS remote tier (`BlobStoreSettings.connectionId`/`connectionKind`,
 * `@centraid/vault`) can point at. Two kinds:
 *
 *   - `byo-s3`   — static S3-compatible credentials the owner supplies
 *                  directly (any S3-compatible endpoint: AWS, R2, MinIO,
 *                  Backblaze…). Sealed at rest, same custody posture as the
 *                  connection broker's credential sidecar (issue #304):
 *                  AES-256-GCM under a dedicated key, never plaintext in the
 *                  JSON settings file.
 *   - `provider` — a Centraid storage-provider account
 *                  (`centraid-storage-provider/1`, packages/backup/PROTOCOL.md):
 *                  a base URL + a sealed api key. Real data-plane credentials
 *                  are short-lived grants (`requestCasGrant`), resolved at use
 *                  time (`storage-credentials.ts`) and never persisted here.
 *
 * Key custody: unlike a vault's DEK (one per vault, minted in a `keys/`
 * sibling of the vault directory — `@centraid/vault`'s `schema/sealed.ts`),
 * this is a GATEWAY-level secret: storage connections are shared across the
 * backup engine and every mounted vault's CAS tier, so no single vault is the
 * natural custodian. A dedicated key file lives beside the connections
 * themselves (`<dir>/connections.sealkey`, 0600) — same shape as a vault's
 * sealkey (`createSealKey`/`loadSealKey`), just scoped to the gateway process
 * instead of one vault. The sealing primitives themselves (`sealValue`,
 * `unsealValue`, `sealAad`) are the exact ones `@centraid/vault` already uses
 * for sealed columns — one AEAD envelope shape across the whole system.
 *
 * Persistence mirrors `backup-state.ts`: atomic JSON writes (temp + rename),
 * 0600, re-read on every mutating call so a concurrent admin CLI and the
 * live daemon never silently diverge.
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  createSealKey,
  loadSealKey,
  sealAad,
  sealValue,
  unsealValue,
  type S3Credentials,
} from '@centraid/vault';

export type StorageConnectionKind = 'byo-s3' | 'provider';
export type StorageConnectionUse = 'backup' | 'cas';

interface StorageConnectionRowBase {
  id: string;
  name: string;
  uses: StorageConnectionUse[];
  createdAt: string;
  updatedAt: string;
}

interface ByoS3Row extends StorageConnectionRowBase {
  kind: 'byo-s3';
  endpoint: string;
  region: string;
  bucket: string;
  prefix?: string;
  /** sealed JSON `{accessKeyId, secretAccessKey, sessionToken?}`. */
  sealedCredentials: string;
}

interface ProviderRow extends StorageConnectionRowBase {
  kind: 'provider';
  baseUrl: string;
  /** sealed JSON `{apiKey}`. */
  sealedCredentials: string;
  /** Provider-issued target id (issue #367 §C1), set once `ensureTarget` has run. */
  targetId?: string;
}

type StorageConnectionRow = ByoS3Row | ProviderRow;

interface StorageConnectionsFile {
  version: 1;
  connections: StorageConnectionRow[];
}

/** The public (never-secret) shape a route/UI reads — Section D consumes this. */
export interface StorageConnectionRecord {
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

export interface CreateByoS3Input {
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

export interface CreateProviderInput {
  kind: 'provider';
  name: string;
  baseUrl: string;
  apiKey: string;
  uses?: StorageConnectionUse[];
}

export type CreateStorageConnectionInput = CreateByoS3Input | CreateProviderInput;
export type UpdateStorageConnectionInput = Partial<CreateByoS3Input> | Partial<CreateProviderInput>;

export class StorageConnectionError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid_request',
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
  const base = {
    id: row.id,
    kind: row.kind,
    name: row.name,
    uses: row.uses,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.kind === 'byo-s3') {
    return {
      ...base,
      endpoint: row.endpoint,
      region: row.region,
      bucket: row.bucket,
      ...(row.prefix ? { prefix: row.prefix } : {}),
    };
  }
  return {
    ...base,
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
    // vault's key (connections outlive, and are shared across, any one vault).
    const key = loadSealKey(keyPath) ?? createSealKey(keyPath);
    const store = new StorageConnectionStore(connectionsFile(dir), key);
    await store.reload();
    return store;
  }

  private async reload(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StorageConnectionsFile>;
      this.rows = Array.isArray(parsed.connections) ? parsed.connections : [];
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
    const id = randomBytes(12).toString('hex');
    const now = new Date().toISOString();
    const uses: StorageConnectionUse[] =
      input.uses && input.uses.length > 0 ? input.uses : ['backup', 'cas'];
    let row: StorageConnectionRow;
    if (input.kind === 'byo-s3') {
      if (!input.endpoint || !input.region || !input.bucket) {
        throw new StorageConnectionError(
          'invalid_request',
          'byo-s3 requires endpoint, region, and bucket',
        );
      }
      if (!input.accessKeyId || !input.secretAccessKey) {
        throw new StorageConnectionError(
          'invalid_request',
          'byo-s3 requires accessKeyId and secretAccessKey',
        );
      }
      row = {
        id,
        kind: 'byo-s3',
        name: input.name,
        uses,
        createdAt: now,
        updatedAt: now,
        endpoint: input.endpoint,
        region: input.region,
        bucket: input.bucket,
        ...(input.prefix ? { prefix: input.prefix } : {}),
        sealedCredentials: this.sealCreds(id, {
          accessKeyId: input.accessKeyId,
          secretAccessKey: input.secretAccessKey,
          ...(input.sessionToken ? { sessionToken: input.sessionToken } : {}),
        }),
      };
    } else if (input.kind === 'provider') {
      if (!input.baseUrl || !input.apiKey) {
        throw new StorageConnectionError('invalid_request', 'provider requires baseUrl and apiKey');
      }
      row = {
        id,
        kind: 'provider',
        name: input.name,
        uses,
        createdAt: now,
        updatedAt: now,
        baseUrl: input.baseUrl,
        sealedCredentials: this.sealCreds(id, { apiKey: input.apiKey }),
      };
    } else {
      throw new StorageConnectionError('invalid_request', 'kind must be "byo-s3" or "provider"');
    }
    this.rows.push(row);
    await this.persist();
    return toRecord(row);
  }

  /**
   * Rotation (issue #367 §C9): changing `endpoint`/`bucket` (byo-s3) or
   * `baseUrl` (provider) is exactly this method — nothing here migrates any
   * vault's custody rows. `storage-routes.ts` propagates the new
   * endpoint/bucket into every referencing vault's `blob_store` settings,
   * which is what actually flips `db.ts`'s `remoteTier()` cache key and
   * starts custody over (see that module's header for why that's enough).
   */
  async update(id: string, patch: UpdateStorageConnectionInput): Promise<StorageConnectionRecord> {
    await this.reload();
    const row = this.requireRow(id);
    const now = new Date().toISOString();
    if (row.kind === 'byo-s3') {
      const p = patch as Partial<CreateByoS3Input>;
      if (p.kind && p.kind !== 'byo-s3') {
        throw new StorageConnectionError('invalid_request', "cannot change a connection's kind");
      }
      if (p.endpoint) row.endpoint = p.endpoint;
      if (p.region) row.region = p.region;
      if (p.bucket) row.bucket = p.bucket;
      if (p.prefix !== undefined) {
        if (p.prefix) row.prefix = p.prefix;
        else delete row.prefix;
      }
      if (p.name) row.name = p.name;
      if (p.uses && p.uses.length > 0) row.uses = p.uses;
      if (p.accessKeyId && p.secretAccessKey) {
        row.sealedCredentials = this.sealCreds(id, {
          accessKeyId: p.accessKeyId,
          secretAccessKey: p.secretAccessKey,
          ...(p.sessionToken ? { sessionToken: p.sessionToken } : {}),
        });
      }
    } else {
      const p = patch as Partial<CreateProviderInput>;
      if (p.kind && p.kind !== 'provider') {
        throw new StorageConnectionError('invalid_request', "cannot change a connection's kind");
      }
      if (p.baseUrl) row.baseUrl = p.baseUrl;
      if (p.name) row.name = p.name;
      if (p.uses && p.uses.length > 0) row.uses = p.uses;
      if (p.apiKey) row.sealedCredentials = this.sealCreds(id, { apiKey: p.apiKey });
    }
    row.updatedAt = now;
    await this.persist();
    return toRecord(row);
  }

  /** Stamp the provider-issued target id once a target has been created (issue #367 §C1/§C10). */
  async setTargetId(id: string, targetId: string): Promise<StorageConnectionRecord> {
    await this.reload();
    const row = this.requireRow(id);
    if (row.kind !== 'provider') {
      throw new StorageConnectionError('invalid_request', `connection "${id}" is not provider-kind`);
    }
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

  /** Resolve S3 credentials for a byo-s3 connection (issue #367 §C3). */
  async resolveS3Credentials(id: string): Promise<S3Credentials> {
    await this.reload();
    const row = this.requireRow(id);
    if (row.kind !== 'byo-s3') {
      throw new StorageConnectionError('invalid_request', `connection "${id}" is not byo-s3`);
    }
    return this.unsealCreds(id, row.sealedCredentials) as unknown as S3Credentials;
  }

  /** Resolve the provider api key for a provider connection (issue #367 §C3). */
  async resolveProviderApiKey(id: string): Promise<string> {
    await this.reload();
    const row = this.requireRow(id);
    if (row.kind !== 'provider') {
      throw new StorageConnectionError('invalid_request', `connection "${id}" is not provider-kind`);
    }
    const creds = this.unsealCreds(id, row.sealedCredentials) as { apiKey: string };
    return creds.apiKey;
  }

  /** The connection's kind without touching sealed material — routes/resolvers branch on this. */
  async kindOf(id: string): Promise<StorageConnectionKind | undefined> {
    await this.reload();
    return this.rows.find((r) => r.id === id)?.kind;
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
