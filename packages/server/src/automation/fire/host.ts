import type { Row } from "../scaffold/app.js";

export interface Host {
  register: (row: Row) => Promise<void>;

  unregister: (automationId: string) => Promise<void>;

  list: () => Promise<readonly string[]>;

  reconcile: (desired: ReadonlyArray<Row>) => Promise<ReconcileResult>;
}

export interface ReconcileResult {
  added: readonly string[];
  updated: readonly string[];
  removed: readonly string[];
}
