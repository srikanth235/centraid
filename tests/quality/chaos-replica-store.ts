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
  close: () => void;
}

export function openDurableOutbox(file: string): DurableOutbox {
  const driver = new FileSqliteDriver(file);
  return {
    queue: new IntentQueue(SqliteIntentStore.create(driver)),
    close: () => driver.close(),
  };
}
