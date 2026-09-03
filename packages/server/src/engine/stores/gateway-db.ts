import { DatabaseSync } from "node:sqlite";

export type DatabaseProvider = () => DatabaseSync;

export function openLedgerDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
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
