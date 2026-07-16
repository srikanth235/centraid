import { open, type DB } from '@op-engineering/op-sqlite';

import {
  replicaDatabaseName,
  type ReplicaBindValue,
  type ReplicaDigest,
  type ReplicaIdentity,
  type ReplicaSqliteDriver,
} from '@centraid/client/replica/native';

import { ReplicaFts5UnavailableError } from './replica-fts5-error';

export { ReplicaFts5UnavailableError } from './replica-fts5-error';

/** Drives the shared replica store core against an in-process op-sqlite handle. */
export class OpSqliteDriver implements ReplicaSqliteDriver {
  private constructor(private readonly db: DB) {}

  /**
   * Open (or create) the replica database. `location` defaults to op-sqlite's
   * per-app documents directory; pass one to override for tests or scoping.
   */
  static open(options: { name: string; location?: string }): OpSqliteDriver {
    const db = open({
      name: options.name,
      ...(options.location === undefined ? {} : { location: options.location }),
    });
    return new OpSqliteDriver(db);
  }

  run(sql: string, bind: readonly ReplicaBindValue[] = []): void {
    this.db.executeSync(sql, bind as ReplicaBindValue[]);
  }

  all<T extends object>(sql: string, bind: readonly ReplicaBindValue[] = []): T[] {
    return this.db.executeSync(sql, bind as ReplicaBindValue[]).rows as T[];
  }

  exec(sql: string): void {
    // op-sqlite's synchronous path runs one statement per call; the store core
    // only passes multi-statement scripts to `exec` (DDL, PRAGMA blocks, tx
    // control), so split on `;` and skip blank fragments.
    for (const statement of splitStatements(sql)) this.db.executeSync(statement);
  }

  close(): void {
    this.db.close();
  }

  assertCapabilities(): void {
    try {
      this.db.executeSync('CREATE VIRTUAL TABLE IF NOT EXISTS temp.__fts5_probe USING fts5(x)');
      this.db.executeSync('DROP TABLE IF EXISTS temp.__fts5_probe');
    } catch {
      throw new ReplicaFts5UnavailableError();
    }
  }
}

/**
 * Open the replica database for one gateway/vault under op-sqlite's per-app
 * documents directory. The filename reuses `@centraid/client`'s storage-key
 * derivation (minus the SAH-pool leading slash, which is web-virtual-FS only),
 * with an injected digest because Hermes has no `crypto.subtle`.
 */
export async function openNativeReplicaDriver(
  identity: ReplicaIdentity,
  digest?: ReplicaDigest,
): Promise<OpSqliteDriver> {
  const name = (await replicaDatabaseName(identity, digest)).replace(/^\/+/, '');
  return OpSqliteDriver.open({ name });
}

/** Split a SQL script into executable statements, ignoring blank fragments. */
function splitStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
