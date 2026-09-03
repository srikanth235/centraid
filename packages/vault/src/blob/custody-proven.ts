import type { VaultDb } from "../db.js";
import { readBlobStoreSettings } from "../db.js";

export function blobCustodyProven(db: VaultDb, sha: string): boolean {
  const remoteConfigured = readBlobStoreSettings(db.vault).kind === "s3";
  if (!remoteConfigured) return db.blobs.hasSync(sha);
  const replicated =
    db.vault.prepare("SELECT 1 FROM blob_replica WHERE sha256 = ?").get(sha) !==
    undefined;
  if (!replicated) return false;
  const pending =
    db.vault.prepare("SELECT 1 FROM blob_outbox WHERE sha256 = ?").get(sha) !==
    undefined;
  return !pending;
}
