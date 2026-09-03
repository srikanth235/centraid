/* oxlint-disable max-classes-per-file -- error and encrypted store form one persistence boundary (#408) */

import { randomBytes } from "node:crypto";
import path from "node:path";

import { KeyStore, sealAad, sealValue, unsealValue } from "@centraid/vault";

import { GatewayDatabase } from "../serve/gateway-db.js";

export type StorageConnectionKind = "provider";

interface ProviderRow {
  id: string;
  kind: "provider";
  name: string;
  createdAt: string;
  updatedAt: string;
  baseUrl: string;
  sealedCredentials: string;
  targetId?: string;
}

type StorageConnectionRow = ProviderRow;

interface StoredProviderRow {
  id: string;
  kind: "provider";
  name: string;
  base_url: string;
  sealed_credentials: string;
  target_id: string | null;
  created_at: string;
  updated_at: string;
}

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
  kind: "provider";
  name: string;
  baseUrl: string;
  apiKey: string;
}

export type CreateStorageConnectionInput = CreateProviderInput;
export type UpdateStorageConnectionInput = Partial<CreateProviderInput>;

export interface StorageConnectionStoreOptions {
  database: GatewayDatabase;
  keyStore: KeyStore;
}

export class StorageConnectionError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "invalid_request"
      | "already_exists"
      | "provider_not_home_profile",
    message: string
  ) {
    super(message);
    this.name = "StorageConnectionError";
  }
}

function fromStored(row: StoredProviderRow): StorageConnectionRow {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    baseUrl: row.base_url,
    sealedCredentials: row.sealed_credentials,
    ...(row.target_id ? { targetId: row.target_id } : {}),
  };
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
  private constructor(
    private readonly database: GatewayDatabase,
    private readonly keyStore: KeyStore
  ) {}

  static async open(
    source: string | StorageConnectionStoreOptions
  ): Promise<StorageConnectionStore> {
    const options =
      typeof source === "string"
        ? {
            database: GatewayDatabase.open(source),
            keyStore: new KeyStore(path.join(source, "keys")),
          }
        : source;
    const store = new StorageConnectionStore(
      options.database,
      options.keyStore
    );
    return store;
  }

  async list(): Promise<StorageConnectionRecord[]> {
    return this.rows().map(toRecord);
  }

  async get(id: string): Promise<StorageConnectionRecord | undefined> {
    const row = this.row(id);
    return row ? toRecord(row) : undefined;
  }

  async create(
    input: CreateStorageConnectionInput
  ): Promise<StorageConnectionRecord> {
    validateCreate(input);
    const id = randomBytes(12).toString("hex");
    const now = new Date().toISOString();
    const row: StorageConnectionRow = {
      id,
      kind: "provider",
      name: input.name,
      createdAt: now,
      updatedAt: now,
      baseUrl: input.baseUrl,
      sealedCredentials: this.sealCreds(id, { apiKey: input.apiKey }),
    };
    this.database.transaction(() => {
      const count = this.database.db
        .prepare("SELECT COUNT(*) AS count FROM storage_connections")
        .get() as { count: number };
      if (count.count > 0) {
        throw new StorageConnectionError(
          "already_exists",
          "a storage connection already exists — only one home connection can be active at a time; delete it before adding another"
        );
      }
      this.insert(row);
    });
    return toRecord(row);
  }

  async update(
    id: string,
    patch: UpdateStorageConnectionInput
  ): Promise<StorageConnectionRecord> {
    const row = this.requireRow(id);
    if (patch.kind && patch.kind !== "provider") {
      throw new StorageConnectionError(
        "invalid_request",
        "cannot change a connection's kind"
      );
    }
    if (patch.baseUrl) row.baseUrl = patch.baseUrl;
    if (patch.name) row.name = patch.name;
    if (patch.apiKey)
      row.sealedCredentials = this.sealCreds(id, { apiKey: patch.apiKey });
    row.updatedAt = new Date().toISOString();
    this.database.db
      .prepare(
        `UPDATE storage_connections
           SET name = ?, base_url = ?, sealed_credentials = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(row.name, row.baseUrl, row.sealedCredentials, row.updatedAt, id);
    return toRecord(row);
  }

  async setTargetId(
    id: string,
    targetId: string
  ): Promise<StorageConnectionRecord> {
    const row = this.requireRow(id);
    row.targetId = targetId;
    row.updatedAt = new Date().toISOString();
    this.database.db
      .prepare(
        "UPDATE storage_connections SET target_id = ?, updated_at = ? WHERE id = ?"
      )
      .run(targetId, row.updatedAt, id);
    return toRecord(row);
  }

  async delete(id: string): Promise<void> {
    const result = this.database.db
      .prepare("DELETE FROM storage_connections WHERE id = ?")
      .run(id);
    if (result.changes === 0) {
      throw new StorageConnectionError(
        "not_found",
        `unknown storage connection "${id}"`
      );
    }
  }

  async resolveProviderApiKey(id: string): Promise<string> {
    const row = this.requireRow(id);
    const creds = this.unsealCreds(id, row.sealedCredentials) as {
      apiKey: string;
    };
    return creds.apiKey;
  }

  private rows(): StorageConnectionRow[] {
    return (
      this.database.db
        .prepare(
          `SELECT id, kind, name, base_url, sealed_credentials, target_id, created_at, updated_at
             FROM storage_connections ORDER BY created_at, id`
        )
        .all() as unknown as StoredProviderRow[]
    ).map(fromStored);
  }

  private row(id: string): StorageConnectionRow | undefined {
    const row = this.database.db
      .prepare(
        `SELECT id, kind, name, base_url, sealed_credentials, target_id, created_at, updated_at
           FROM storage_connections WHERE id = ?`
      )
      .get(id) as StoredProviderRow | undefined;
    return row ? fromStored(row) : undefined;
  }

  private requireRow(id: string): StorageConnectionRow {
    const row = this.row(id);
    if (!row)
      throw new StorageConnectionError(
        "not_found",
        `unknown storage connection "${id}"`
      );
    return row;
  }

  private insert(row: StorageConnectionRow): void {
    this.database.db
      .prepare(
        `INSERT INTO storage_connections
          (id, kind, name, base_url, sealed_credentials, target_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.id,
        row.kind,
        row.name,
        row.baseUrl,
        row.sealedCredentials,
        row.targetId ?? null,
        row.createdAt,
        row.updatedAt
      );
  }

  private sealCreds(id: string, value: Record<string, unknown>): string {
    return sealValue(
      this.connectionKey(),
      sealAad("storage_connection", "credentials", id),
      JSON.stringify(value)
    );
  }

  private unsealCreds(id: string, sealed: string): Record<string, unknown> {
    return JSON.parse(
      unsealValue(
        this.connectionKey(),
        sealAad("storage_connection", "credentials", id),
        sealed
      )
    ) as Record<string, unknown>;
  }

  private connectionKey(): Buffer {
    return this.keyStore.loadOrCreate("connections.sealkey");
  }
}

function validateCreate(input: CreateStorageConnectionInput): void {
  if (!input.name || input.name.trim().length === 0) {
    throw new StorageConnectionError("invalid_request", "name is required");
  }
  if (input.kind !== "provider") {
    throw new StorageConnectionError(
      "invalid_request",
      'kind must be "provider"'
    );
  }
  if (!input.baseUrl || !input.apiKey) {
    throw new StorageConnectionError(
      "invalid_request",
      "provider requires baseUrl and apiKey"
    );
  }
}

export function openStorageConnectionStore(
  source: string | StorageConnectionStoreOptions
): Promise<StorageConnectionStore> {
  return StorageConnectionStore.open(source);
}
