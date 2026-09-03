import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { EngineLogger } from "@centraid/backup";
import { FsBlobStore, ReplicaIndex } from "@centraid/vault";

export interface ReconcileLogger extends EngineLogger {
  error?: (msg: string) => void;
}

export interface ReconcileReport {
  checked: number;
  missing: number;
  repinned: string[];
  lost: string[];
  skipped?: string;
}

export interface ReconcileAdoptedInventoryOptions {
  vaultDir: string;
  remoteShas: Set<string> | undefined;
  snapshotEntries: readonly string[];
  materialize: (shas: string[]) => Promise<string[]>;
  log?: ReconcileLogger;
}

function snapshotBlobShas(entries: readonly string[]): Set<string> {
  const shas = new Set<string>();
  for (const p of entries) {
    if (!p.startsWith("blobs/")) continue;
    const last = p.split("/").pop();
    if (last && /^[0-9a-f]{64}$/u.test(last)) shas.add(last);
  }
  return shas;
}

function preview(shas: readonly string[]): string {
  return shas.length <= 6
    ? shas.join(", ")
    : `${shas.slice(0, 6).join(", ")}, +${shas.length - 6} more`;
}

export async function reconcileAdoptedInventory(
  opts: ReconcileAdoptedInventoryOptions
): Promise<ReconcileReport> {
  const { vaultDir, remoteShas, snapshotEntries, materialize, log } = opts;
  if (remoteShas === undefined) {
    log?.info?.(
      "recover: provider attests no inventory — skipping adopt-time reconcile; the restored " +
        "blob_replica index is trusted as-is"
    );
    return {
      checked: 0,
      missing: 0,
      repinned: [],
      lost: [],
      skipped: "no-inventory-capability",
    };
  }

  const carried = snapshotBlobShas(snapshotEntries);
  const blobs = new FsBlobStore(path.join(vaultDir, "blobs"));
  const db = new DatabaseSync(path.join(vaultDir, "vault.db"));
  try {
    const index = new ReplicaIndex(db);
    const believed = [...index.all("cas")];
    const missing = believed.filter((sha) => !remoteShas.has(sha));

    const toFetch = missing.filter(
      (sha) => carried.has(sha) && !blobs.hasSync(sha)
    );
    const fetched = new Set(
      toFetch.length > 0 ? await materialize(toFetch) : []
    );

    const repinned: string[] = [];
    const lost: string[] = [];
    for (const sha of missing) {
      index.unmark(sha);
      if (carried.has(sha) && (blobs.hasSync(sha) || fetched.has(sha)))
        repinned.push(sha);
      else lost.push(sha);
    }

    if (repinned.length > 0) {
      log?.warn?.(
        `recover: ${repinned.length} blob(s) the provider no longer holds were re-pinned from the ` +
          `snapshot and blob_replica corrected (${preview(repinned)}); they will re-upload on the next backup`
      );
    }
    if (lost.length > 0) {
      (log?.error ?? log?.warn)?.(
        `recover: CRITICAL — ${lost.length} blob(s) the restored vault believed durable are NOT held by ` +
          `the provider and the snapshot does not carry them; they are LOST (${preview(lost)}). blob_replica ` +
          "was corrected so nothing evicts a phantom local copy, but the bytes are unrecoverable"
      );
    }

    return {
      checked: believed.length,
      missing: missing.length,
      repinned,
      lost,
    };
  } finally {
    db.close();
  }
}
