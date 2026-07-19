// Measured child for the vault write-path fsync probe. This opens a REAL vault
// through the vault package's public API (the same openVaultDb + bootstrapVault
// pair @centraid/test-kit's createTestVault uses) so the write path under trace
// is the production one: on-disk WAL, `PRAGMA synchronous=FULL`, the
// auto_vacuum/mmap posture from db.ts, and the durable replica-protocol triggers
// that fire inside every mutating transaction. The previous version hand-rolled
// a bare `DatabaseSync` with its own PRAGMAs and therefore measured nothing the
// product actually runs.
//
// A syscall tracer (strace on Linux) wraps this process to count fsync/fdatasync
// over N genuine journalled writes. Node-level node:fs patching is deliberately
// NOT used: SQLite issues its commit syncs from C (fdatasync on Linux, fcntl
// F_FULLFSYNC on macOS), so only a syscall tracer sees the real commit cost.
import { bootstrapVault, openVaultDb } from '../../../packages/vault/dist/index.js';

const [dir, rawWrites] = process.argv.slice(2);
if (!dir) throw new Error('vault directory is required');
const writes = Number(rawWrites ?? 500);

const db = openVaultDb({ dir });
bootstrapVault(db, { ownerName: 'Perf owner' });

// core_party is a canonical ontology table: inserting a row fires the durable
// replica-protocol triggers installed at open, so each COMMIT is a genuine
// journalled write in the real durability posture — not a bare INSERT.
const insert = db.vault.prepare(
  `INSERT INTO core_party
     (party_id, kind, display_name, created_at, updated_at, ontology_version)
   VALUES (?, 'person', ?, ?, ?, '1.2')`,
);
for (let index = 0; index < writes; index += 1) {
  db.vault.exec('BEGIN IMMEDIATE');
  insert.run(`perf-${index}`, `Perf party ${index}`, index, index);
  db.vault.exec('COMMIT');
}
db.close();
