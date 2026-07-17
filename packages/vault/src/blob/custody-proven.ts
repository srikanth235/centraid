// The custody-proven latch for the conversation-ledger prune (issue #438
// decision 3). The app-engine archival engine takes this as an injected seam
// (`custodyProven`), and the gateway composes it from vault primitives here —
// only the vault knows the remote-tier settings, the replication index, and the
// outbox obligations. Proof is deliberately conservative (fail closed): when in
// doubt a segment stays UN-proven, so its raw rows are never pruned and history
// is never the sole copy of itself mid-flight.

import type { VaultDb } from '../db.js';
import { readBlobStoreSettings } from '../db.js';

/**
 * Whether an archive segment's bytes are durable enough to prune its raw rows:
 *   - remote tier configured (`blob_store.kind === 's3'`) ⇒ the sha carries
 *     durable replica evidence (`blob_replica`) AND has NO pending outbox
 *     obligation (`blob_outbox`) — a replacement upload still in flight leaves
 *     it un-proven, exactly as `refreshCustodyState` layers pending-offsite.
 *   - no remote tier ⇒ local CAS presence suffices (#367 parity: on a
 *     local-only vault the sealed segment IS the durable copy, and pruning
 *     still frees ledger pages by collapsing many rows into one blob).
 * Declaring s3 but failing to replicate (no credential resolver, dead endpoint)
 * keeps the sha un-proven forever — raw rows simply persist, which is safe.
 */
export function blobCustodyProven(db: VaultDb, sha: string): boolean {
  const remoteConfigured = readBlobStoreSettings(db.vault).kind === 's3';
  if (!remoteConfigured) return db.blobs.hasSync(sha);
  const replicated =
    db.vault.prepare('SELECT 1 FROM blob_replica WHERE sha256 = ?').get(sha) !== undefined;
  if (!replicated) return false;
  const pending =
    db.vault.prepare('SELECT 1 FROM blob_outbox WHERE sha256 = ?').get(sha) !== undefined;
  return !pending;
}
