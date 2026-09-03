import { DatabaseSync } from "node:sqlite";

import type {
  ReplicaBindValue,
  ReplicaSqliteDriver,
} from "@centraid/client/replica/native";

export class NodeSqliteFileDriver implements ReplicaSqliteDriver {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
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
