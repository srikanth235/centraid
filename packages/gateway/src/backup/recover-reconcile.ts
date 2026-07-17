/*
 * Adopt-time inventory reconcile (issue #439 R5) — a recover()-internal step
 * that runs ALWAYS, immediately after the staging dir becomes the live vault
 * (`recover.ts`, right at the `onAdopted` position), never gated on a caller
 * passing a hook.
 *
 * The problem (gap 4): a restored vault inherits the SOURCE machine's
 * `blob_replica` index, which attests each sha was durable on the remote AS OF
 * CAPTURE TIME. Between then and this recovery the provider may have lost,
 * purged, or never-actually-held some of those objects — so the belief "this
 * blob is safely off-disk" is stale, and trusting it would let custody/eviction
 * drop the only local copy of a byte the remote no longer has.
 *
 * So we replace the belief with truth: the provider's ATTESTED cas inventory
 * (the same set the lazy skip-set was built from — collected once, reused). Any
 * sha the restored index believes 'cas'-durable that the live inventory does NOT
 * hold is a divergence, and we:
 *   - `unmark` it in `blob_replica` (the vault must stop believing the remote
 *     holds it, so eviction never drops a local copy and replication re-uploads
 *     it), and
 *   - if the snapshot CARRIES the blob, ensure it is materialized locally
 *     (re-pinned) — the lazy restore already downloads any not-in-inventory blob,
 *     so this is a guarantee, with `materializeSnapshotBlobs` the fallback for
 *     the cases restore did not (a `--full` run's direct-CAS-only shas, or any
 *     divergence a caller's own skip predicate introduced); or
 *   - if the snapshot does NOT carry it (a direct-to-CAS original the remote was
 *     the sole copy of), record it LOST — CRITICAL, nothing to re-pin.
 *
 * A provider with no `inventory` capability can attest nothing, so the reconcile
 * SKIPS honestly (`skipped: 'no-inventory-capability'`) and leaves the restored
 * index untouched rather than second-guessing it.
 */

import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { EngineLogger } from '@centraid/backup';
import { FsBlobStore, ReplicaIndex } from '@centraid/vault';

/** A logger that can also shout at error level (the LOST case is CRITICAL). */
export interface ReconcileLogger extends EngineLogger {
  error?: (msg: string) => void;
}

/** The R5 outcome carried in `RecoverReport.reconcile`. */
export interface ReconcileReport {
  /** How many shas the restored index believed 'cas'-durable (the checked set). */
  checked: number;
  /** How many of those the provider's live inventory does NOT hold. */
  missing: number;
  /** Missing shas the snapshot carried and are now local again (`missing` re-pinned). */
  repinned: string[];
  /** Missing shas the snapshot did NOT carry — permanently gone (CRITICAL). */
  lost: string[];
  /** Set instead of reconciling when the provider attests no inventory. */
  skipped?: string;
}

export interface ReconcileAdoptedInventoryOptions {
  /** `<vaultRoot>/<vaultId>` — the freshly adopted vault (its `vault.db` + `blobs/`). */
  vaultDir: string;
  /** The provider's attested cas inventory (reused from the skip-set), or undefined with no capability. */
  remoteShas: Set<string> | undefined;
  /** `RestoreResult.entries` — every manifest path, so we know what the snapshot carries. */
  snapshotEntries: readonly string[];
  /** Stream the given snapshot-carried shas to `<vaultDir>/blobs`; returns the ones written. */
  materialize: (shas: string[]) => Promise<string[]>;
  log?: ReconcileLogger;
}

/** Shas the snapshot carries, from its manifest entry paths (`blobs/sha256/<fan>/<sha>`). */
function snapshotBlobShas(entries: readonly string[]): Set<string> {
  const shas = new Set<string>();
  for (const p of entries) {
    if (!p.startsWith('blobs/')) continue;
    const last = p.split('/').pop();
    if (last && /^[0-9a-f]{64}$/.test(last)) shas.add(last);
  }
  return shas;
}

function preview(shas: readonly string[]): string {
  return shas.length <= 6
    ? shas.join(', ')
    : `${shas.slice(0, 6).join(', ')}, +${shas.length - 6} more`;
}

export async function reconcileAdoptedInventory(
  opts: ReconcileAdoptedInventoryOptions,
): Promise<ReconcileReport> {
  const { vaultDir, remoteShas, snapshotEntries, materialize, log } = opts;
  if (remoteShas === undefined) {
    log?.info?.(
      'recover: provider attests no inventory — skipping adopt-time reconcile; the restored ' +
        'blob_replica index is trusted as-is',
    );
    return { checked: 0, missing: 0, repinned: [], lost: [], skipped: 'no-inventory-capability' };
  }

  const carried = snapshotBlobShas(snapshotEntries);
  const blobs = new FsBlobStore(path.join(vaultDir, 'blobs'));
  const db = new DatabaseSync(path.join(vaultDir, 'vault.db'));
  try {
    const index = new ReplicaIndex(db);
    const believed = [...index.all('cas')];
    const missing = believed.filter((sha) => !remoteShas.has(sha));

    // Re-pin the snapshot-carried missing blobs the restore did not already
    // land locally — reusing the engine's chunk-stream/verify path.
    const toFetch = missing.filter((sha) => carried.has(sha) && !blobs.hasSync(sha));
    const fetched = new Set(toFetch.length > 0 ? await materialize(toFetch) : []);

    const repinned: string[] = [];
    const lost: string[] = [];
    for (const sha of missing) {
      // Truth wins: the remote does not hold it, so the vault must not believe it does.
      index.unmark(sha);
      if (carried.has(sha) && (blobs.hasSync(sha) || fetched.has(sha))) repinned.push(sha);
      else lost.push(sha);
    }

    if (repinned.length > 0) {
      log?.warn?.(
        `recover: ${repinned.length} blob(s) the provider no longer holds were re-pinned from the ` +
          `snapshot and blob_replica corrected (${preview(repinned)}); they will re-upload on the next backup`,
      );
    }
    if (lost.length > 0) {
      (log?.error ?? log?.warn)?.(
        `recover: CRITICAL — ${lost.length} blob(s) the restored vault believed durable are NOT held by ` +
          `the provider and the snapshot does not carry them; they are LOST (${preview(lost)}). blob_replica ` +
          'was corrected so nothing evicts a phantom local copy, but the bytes are unrecoverable',
      );
    }

    return { checked: believed.length, missing: missing.length, repinned, lost };
  } finally {
    db.close();
  }
}
