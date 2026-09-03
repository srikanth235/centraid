import type { DatabaseSync } from "node:sqlite";

import type { VaultDb } from "../db.js";
import { nowIso } from "../ids.js";
import type { CustodyState } from "./custody-types.js";
import { shaOfBlobUri } from "./store.js";

export async function refreshCustodyState(
  db: VaultDb
): Promise<{ updated: number }> {
  const rows = db.vault
    .prepare(
      `SELECT content_id, content_uri FROM core_content_item
        WHERE content_uri LIKE 'blob:%' AND deleted_at IS NULL`
    )
    .all() as { content_id: string; content_uri: string }[];
  const byContent = new Map<string, string>();
  const shas = new Set<string>();
  for (const row of rows) {
    const sha = shaOfBlobUri(row.content_uri);
    if (!sha) continue;
    byContent.set(row.content_id, sha);
    shas.add(sha);
  }
  const status = await db.blobs.statusFor(shas);
  const pending = new Set(
    (
      db.vault.prepare("SELECT sha256 FROM blob_outbox").all() as {
        sha256: string;
      }[]
    ).map((row) => row.sha256)
  );
  const now = nowIso();
  db.vault.exec("BEGIN");
  try {
    db.vault.prepare("DELETE FROM blob_custody_state").run();
    const insert = db.vault.prepare(
      `INSERT INTO blob_custody_state (content_id, sha256, custody_state, checked_at)
       VALUES (?, ?, ?, ?)`
    );
    for (const [contentId, sha] of byContent) {
      insert.run(
        contentId,
        sha,
        pending.has(sha) ? "pending-offsite" : (status.get(sha) ?? "missing"),
        now
      );
    }
    db.vault.exec("COMMIT");
  } catch (error) {
    db.vault.exec("ROLLBACK");
    throw error;
  }
  return { updated: byContent.size };
}

export function custodyStateCounts(
  vault: DatabaseSync
): Record<CustodyState, number> {
  const counts: Record<CustodyState, number> = {
    "pending-offsite": 0,
    "local-only": 0,
    replicated: 0,
    "remote-only": 0,
    missing: 0,
  };
  const rows = vault
    .prepare(
      `SELECT custody_state, COUNT(*) AS n FROM blob_custody_state GROUP BY custody_state`
    )
    .all() as { custody_state: CustodyState; n: number }[];
  for (const row of rows) counts[row.custody_state] = row.n;
  return counts;
}

export function custodyStateByteCounts(
  vault: DatabaseSync
): Record<CustodyState, number> {
  const bytes: Record<CustodyState, number> = {
    "pending-offsite": 0,
    "local-only": 0,
    replicated: 0,
    "remote-only": 0,
    missing: 0,
  };
  const rows = vault
    .prepare(
      `SELECT s.custody_state AS custody_state, COALESCE(SUM(c.byte_size), 0) AS bytes
         FROM blob_custody_state s
         JOIN core_content_item c ON c.content_id = s.content_id
        GROUP BY s.custody_state`
    )
    .all() as { custody_state: CustodyState; bytes: number }[];
  for (const row of rows) bytes[row.custody_state] = row.bytes;
  return bytes;
}
