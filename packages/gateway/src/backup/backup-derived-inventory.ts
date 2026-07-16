/*
 * The `derived` store class reconciliation fold (issue #425 Wave 2). Kept in its
 * own module so `backup-reconciliation.ts` stays under the governance line-cap.
 *
 * The reconciliation sweep MUST diff every granted store class. Wave 2 adds the
 * `derived` store (binary display derivatives — thumb/preview/poster) alongside
 * `cas`: a derived replica missing from the DERIVED listing is missing even if
 * the same sha happens to sit under cas, and `unmark` runs synchronously so the
 * next cache eviction cannot trust evidence the derived listing did not confirm.
 * The drift is folded into the `cas` store-reconciliation state rather than a
 * second top-level store field, so the audit report + status stay one shape;
 * derived is a small reconstructible set, so surfacing its missing/orphans
 * alongside cas keeps the owner-facing signal honest without churning consumers.
 */

import { ReplicaIndex, type VaultDb } from '@centraid/vault';
import { collectCasInventory } from './backup-cas-inventory.js';
import type { DriftSummary, StoreReconciliationState } from './backup-reconciliation-state.js';
import type { StorageConnectionStore } from './storage-connections.js';

const SAMPLE_LIMIT = 25;

// Prefix-agnostic sha extraction — matches `.../blobs/sha256/{64hex}` under any
// store prefix, so a derived-prefixed object key resolves to its sha the same
// way a cas one does (kept local to break the module cycle with the cas diff).
function casSha(key: string): string | undefined {
  return /(?:^|\/)blobs\/(?:sha256\/)?([0-9a-f]{64})$/.exec(key)?.[1];
}

function drift(list: Iterable<string>): DriftSummary {
  const sample = [...new Set(list)].sort();
  return { count: sample.length, sample: sample.slice(0, SAMPLE_LIMIT) };
}

/** Union two drift summaries (folding derived into cas). */
function mergeDrift(a: DriftSummary, b: DriftSummary): DriftSummary {
  const sample = [...new Set([...a.sample, ...b.sample])].sort().slice(0, SAMPLE_LIMIT);
  return { count: a.count + b.count, sample };
}

/**
 * Diff the derived store class and fold its drift into the cas store state.
 * Self-contained (no dependency on the cas reconciler) so the two modules stay
 * acyclic; the diff logic mirrors `reconcileCasInventory` but touches only
 * `store='derived'` replica rows and folds `missing`/`orphans` into `cas`.
 */
export async function reconcileDerivedInto(opts: {
  cas: StoreReconciliationState;
  db: VaultDb;
  storageConnections?: StorageConnectionStore;
  verifyBucket: boolean;
  live: Set<string>;
  checkedAt: string;
  /** Deterministic collection seam for focused tests (mirrors the cas seam). */
  collect?: typeof collectCasInventory;
}): Promise<void> {
  const collect = opts.collect ?? collectCasInventory;
  const result = await collect({
    db: opts.db,
    ...(opts.storageConnections ? { storageConnections: opts.storageConnections } : {}),
    verifyBucket: opts.verifyBucket,
    store: 'derived',
  });
  if (!result.collection) return; // store not granted / unavailable — nothing to fold
  const index = new ReplicaIndex(opts.db.vault);
  const rows = index.rows().filter((row) => row.store === 'derived');
  const indexed = new Set(rows.map((row) => row.sha256));
  const recentlyIndexed = new Set(
    rows.filter((row) => row.replicatedAt >= opts.checkedAt).map((row) => row.sha256),
  );
  const remote = new Set<string>();
  const unknownKeys: string[] = [];
  for (const object of result.collection.objects) {
    if (object.state !== 'live') continue;
    const sha = casSha(object.key);
    if (sha) remote.add(sha);
    else unknownKeys.push(object.key);
  }
  // A derived replica the derived listing does not confirm is missing (even if
  // the same sha sits under cas); unmark synchronously so the next eviction
  // cannot trust it.
  const missing = [...indexed].filter((sha) => !remote.has(sha) && !recentlyIndexed.has(sha));
  for (const sha of missing) index.unmark(sha);
  const orphans = [...remote].filter((sha) => !opts.live.has(sha));
  opts.cas.missing = mergeDrift(opts.cas.missing, drift(missing));
  opts.cas.orphans = mergeDrift(opts.cas.orphans, drift([...orphans, ...unknownKeys]));
}
