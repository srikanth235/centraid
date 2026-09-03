/*
 * app-engine READS AND WRITES the conversation-ledger band of `vault.db`; it no
 * longer owns its shape. Since #916 there is ONE file, and the vault package
 * composes the band's tables, triggers, `run_summary` view and FTS index in
 * `schema/ledger.ts` as part of the baseline — so a ledger row and the audit
 * receipt beside it share one transaction, and this module never issues DDL.
 *
 * The band is runtime-owned and MUTABLE, so it is not part of the audit
 * contract. `turns.conversation_id`, `items.turn_id` and `attachments.item_id`
 * are same-file CASCADE FKs; `turns.parent_turn_id` stays a plain column
 * because a sub-run's parent may be recorded after this row in one batch.
 * A conversation binds to its vault at creation, so a mid-thread switch cannot
 * smear one across two vaults (#280), and none of it is reachable from handler
 * `db` or the `vault_sql` tool.
 */

import { DatabaseSync } from "node:sqlite";

/**
 * LAZY, because registration code runs in every worker subprocess and only the
 * gateway worker serves the routes that touch this state.
 *
 * A provider may resolve to a DIFFERENT handle across calls (#280): a vault
 * switch changes what it returns, so a store caching prepared statements must
 * compare the handle per call and re-prepare on change.
 */
export type DatabaseProvider = () => DatabaseSync;

/**
 * Open a MIGRATED `vault.db` by path, for the worker subprocesses that reach
 * the ledger band without the gateway's handle. It issues no DDL: the band is
 * already there, put in place by `migrateVault` when the gateway opened the
 * vault. Pragmas run OUTSIDE any transaction (journal_mode in particular).
 */
export function openLedgerDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  // busy_timeout is a STALL BUDGET (#659): this driver is synchronous, so the
  // wait is a blocked event loop and a long timeout presents a hard-down
  // gateway as a slow one.
  //
  // wal_autocheckpoint=0 keeps the WAL shipper the sole checkpointer — a
  // PERFORMANCE HINT, not a correctness requirement (#411), since the shipper
  // detects and heals a foreign checkpoint. Per connection, so EVERY by-path
  // opener sets it.
  //
  // auto_vacuum=INCREMENTAL MUST precede journal_mode=WAL (#438): once WAL
  // writes page 1 the header is fixed and only a full VACUUM can convert.
  db.exec(`
    PRAGMA page_size=8192;
    PRAGMA auto_vacuum=INCREMENTAL;
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=10000;
    PRAGMA cache_size=-16000;
    PRAGMA mmap_size=67108864;
    PRAGMA temp_store=MEMORY;
    PRAGMA wal_autocheckpoint=0;
  `);
  // A fresh file reads back 2 (the pragma is pending); only a pre-existing
  // NON-empty file still reads 0, and one full VACUUM converts it.
  const autoVacuum = (
    db.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number }
  ).auto_vacuum;
  const pageCount = (
    db.prepare("PRAGMA page_count").get() as { page_count: number }
  ).page_count;
  if (autoVacuum === 0 && pageCount > 0) db.exec("VACUUM");
  return db;
}

export function makeLedgerDbProvider(dbPath: string): DatabaseProvider {
  let db: DatabaseSync | undefined;
  return () => {
    if (!db) db = openLedgerDb(dbPath);
    return db;
  };
}
