/**
 * A FILE-BACKED replica outbox driver for the composition-chaos lane (#842 W3.2).
 *
 * `NodeSqliteDriver` (the store-conformance stand-in for op-sqlite) opens
 * `:memory:`, so closing it destroys the outbox rather than restarting it —
 * which would turn "the phone's process died mid-flight" into "the phone
 * forgot", and the durable-outbox law would be unfalsifiable. This driver is
 * the same synchronous seam over a real file, so `close()` + reopen is a real
 * restart of a real durable store and `recoverSending()` has something to
 * recover.
 *
 * Test-only, and deliberately a sibling of the kit's in-memory driver rather
 * than a change to it: the conformance suites want the ephemeral one.
 */

import { DatabaseSync } from "node:sqlite";

import { SqliteIntentStore } from "../../apps/mobile/src/lib/replica/sqlite-intent-store.js";
import { IntentQueue } from "../../packages/client/src/replica/intents.js";
import type {
  ReplicaBindValue,
  ReplicaSqliteDriver,
} from "../../packages/client/src/replica/store-core.js";

class FileSqliteDriver implements ReplicaSqliteDriver {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
  }

  run(sql: string, bind: readonly ReplicaBindValue[] = []): void {
    this.db.prepare(sql).run(...bind);
  }

  all<T extends object>(
    sql: string,
    bind: readonly ReplicaBindValue[] = []
  ): T[] {
    return this.db.prepare(sql).all(...bind) as T[];
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}

export interface DurableOutbox {
  readonly queue: IntentQueue;
  /** Close the underlying file handle — the process-death half of a restart. */
  close: () => void;
}

/** Open (or reopen) the durable outbox stored at `file`. */
export function openDurableOutbox(file: string): DurableOutbox {
  const driver = new FileSqliteDriver(file);
  return {
    queue: new IntentQueue(SqliteIntentStore.create(driver)),
    close: () => driver.close(),
  };
}
