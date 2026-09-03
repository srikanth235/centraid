import { DatabaseSync } from "node:sqlite";

import type {
  ReplicaBindValue,
  ReplicaSqliteDriver,
} from "@centraid/client/replica/native";

export class NodeSqliteDriver implements ReplicaSqliteDriver {
  private readonly db: DatabaseSync;

  constructor(filename = ":memory:") {
    this.db = new DatabaseSync(filename);
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

  allAsync<T extends object>(
    sql: string,
    bind: readonly ReplicaBindValue[] = []
  ): Promise<T[]> {
    return Promise.resolve(this.all<T>(sql, bind));
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}
