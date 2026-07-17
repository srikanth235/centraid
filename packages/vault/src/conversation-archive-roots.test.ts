// GC roots for the conversation-ledger band (issue #438 decision 6). Mirrors
// the retained-snapshot pin test (blob/blob.test.ts): an archive-row sha must
// read as reachable so the reconcile sweep never deletes the only durable copy
// of pruned rows. Also covers the missing-table guard.

import { expect, test } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openVaultDb } from './db.js';
import { conversationArchiveShas } from './conversation-archive-roots.js';
import { sha256OfBytes } from './blob/store.js';

// Minimal slice of the app-engine-owned band the roots reader touches. Inlined
// (not imported from @centraid/app-engine) because the vault package must never
// depend on app-engine — the reader reaches the table by SQL precisely so the
// layering stays one-way.
function ensureLedger(journal: DatabaseSync): void {
  journal.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, user_id TEXT NOT NULL,
      automation_id TEXT, title TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS conversation_archive (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
      seq_from INTEGER NOT NULL, seq_to INTEGER NOT NULL,
      from_time INTEGER NOT NULL, to_time INTEGER NOT NULL,
      turn_count INTEGER NOT NULL, item_count INTEGER NOT NULL,
      segment_sha256 TEXT NOT NULL, segment_bytes INTEGER NOT NULL,
      plaintext_bytes INTEGER NOT NULL, attachment_hashes_json TEXT NOT NULL DEFAULT '[]',
      pruned_at INTEGER, created_at INTEGER NOT NULL
    ) STRICT;
  `);
}

test('an archive-row segment sha reads as a live GC root', () => {
  const db = openVaultDb({});
  ensureLedger(db.journal);
  const conv = 'app/digest';
  db.journal
    .prepare(
      `INSERT INTO conversations (id, kind, user_id, automation_id, title, created_at, updated_at)
       VALUES (?, 'automation', 'u1', ?, 'D', 0, 0)`,
    )
    .run(conv, conv);
  const sha = sha256OfBytes(Buffer.from('segment bytes'));
  db.journal
    .prepare(
      `INSERT INTO conversation_archive
         (id, conversation_id, seq_from, seq_to, from_time, to_time, turn_count, item_count,
          segment_sha256, segment_bytes, plaintext_bytes, attachment_hashes_json, created_at)
       VALUES ('ar1', ?, 0, 3, 0, 1, 4, 8, ?, 100, 200, '[]', 0)`,
    )
    .run(conv, sha);

  const roots = conversationArchiveShas(db.journal);
  expect(roots.has(sha)).toBe(true);
  expect(roots.size).toBe(1);
  db.close();
});

test('a pruned archive row is STILL a root (its segment is the only copy left)', () => {
  const db = openVaultDb({});
  ensureLedger(db.journal);
  const sha = sha256OfBytes(Buffer.from('pruned segment'));
  db.journal
    .prepare(
      `INSERT INTO conversations (id, kind, user_id, automation_id, title, created_at, updated_at)
       VALUES ('a/x','automation','u1','a/x','x',0,0)`,
    )
    .run();
  db.journal
    .prepare(
      `INSERT INTO conversation_archive
         (id, conversation_id, seq_from, seq_to, from_time, to_time, turn_count, item_count,
          segment_sha256, segment_bytes, plaintext_bytes, attachment_hashes_json, pruned_at, created_at)
       VALUES ('ar1','a/x',0,1,0,1,2,4, ?, 50, 90, '[]', 123, 0)`,
    )
    .run(sha);
  expect(conversationArchiveShas(db.journal).has(sha)).toBe(true);
  db.close();
});

test('returns the empty set when the ledger band has not been created yet', () => {
  const db = openVaultDb({});
  // No ensureLedger — the vault opened the journal before app-engine ensured
  // the conversation band. The guard must not throw "no such table".
  expect(conversationArchiveShas(db.journal).size).toBe(0);
  db.close();
});
