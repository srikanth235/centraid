/**
 * Every host that fires automations on a schedule (today: `InProcessScheduler`,
 * #149 — no OS scheduler, no backfill). Callers drive this interface through
 * `reconcile`, never the host's primitives; `desired` is always the FULL set of
 * user-owned automations, keyed by `<ownerApp>/<id>`.
 */

import type { Row } from "../scaffold/app.js";

export interface Host {
  /** Idempotent, and the toggle path — hosts choose how to represent
   *  `enabled: false`. */
  register: (row: Row) => Promise<void>;

  /** Idempotent; tolerates "not present". */
  unregister: (automationId: string) => Promise<void>;

  list: () => Promise<readonly string[]>;

  reconcile: (desired: ReadonlyArray<Row>) => Promise<ReconcileResult>;
}

export interface ReconcileResult {
  added: readonly string[];
  updated: readonly string[];
  removed: readonly string[];
}
