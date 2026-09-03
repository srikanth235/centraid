import type { DatabaseSync } from "node:sqlite";

export function conversationArchiveShas(journal: DatabaseSync): Set<string> {
  const shas = new Set<string>();
  const hasTable = journal
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_archive'`
    )
    .get();
  if (!hasTable) return shas;
  const rows = journal
    .prepare(`SELECT segment_sha256 FROM conversation_archive`)
    .all() as {
    segment_sha256: string;
  }[];
  for (const r of rows) shas.add(r.segment_sha256);
  return shas;
}
