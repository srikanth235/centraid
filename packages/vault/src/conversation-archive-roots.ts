// CAS GC roots for the conversation-ledger band (issue #438 decision 6). The
// `conversation_archive` table is created by app-engine, but it lives in the
// SAME journal.db the vault holds open, so this vault-side reader lets every
// custody/backup GC path union its segment shas WITHOUT the vault importing
// app-engine (which would invert the layering). Mirrors `archivedSegmentShas`
// (journal-archive.ts) exactly, including the fail-safe contract: an
// unavailable root set must never narrow `liveShas` and turn a claimed blob
// into an orphan.
//
// The vault can open a journal before app-engine has ensured the ledger band
// (a fresh vault the gateway has never served conversations from), so this
// guards on the table's existence in sqlite_master and returns the empty set
// rather than throwing "no such table".

import type { DatabaseSync } from 'node:sqlite';

/**
 * Every conversation-archive segment sha the index still references (pruned or
 * not — a pruned segment is the ONLY durable copy of its rows and must stay
 * pinned forever). Empty when the ledger band has not been created yet.
 */
export function conversationArchiveShas(journal: DatabaseSync): Set<string> {
  const shas = new Set<string>();
  const hasTable = journal
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_archive'`)
    .get();
  if (!hasTable) return shas;
  const rows = journal.prepare(`SELECT segment_sha256 FROM conversation_archive`).all() as {
    segment_sha256: string;
  }[];
  for (const r of rows) shas.add(r.segment_sha256);
  return shas;
}
