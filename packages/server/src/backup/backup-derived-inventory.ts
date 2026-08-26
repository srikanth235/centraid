/* Sweep MUST diff every granted store class (#425): derived replicas absent from the DERIVED listing are missing even if the sha sits under cas. */

import { ReplicaIndex } from "@centraid/vault";
import type { VaultDb } from "@centraid/vault";

import { collectCasInventory } from "./backup-cas-inventory.js";
import type {
  DriftSummary,
  StoreReconciliationState,
} from "./backup-reconciliation-state.js";
import type { StorageConnectionStore } from "./storage-connections.js";

const SAMPLE_LIMIT = 25;

// Prefix-agnostic sha extraction; breaks the module cycle with the cas diff.
function casSha(key: string): string | undefined {
  return /(?:^|\/)blobs\/(?:sha256\/)?(?<sha>[0-9a-f]{64})$/u.exec(key)?.groups
    ?.sha;
}

function drift(list: Iterable<string>): DriftSummary {
  const sample = [...new Set(list)].sort();
  return { count: sample.length, sample: sample.slice(0, SAMPLE_LIMIT) };
}

function mergeDrift(a: DriftSummary, b: DriftSummary): DriftSummary {
  const sample = [...new Set([...a.sample, ...b.sample])]
    .sort()
    .slice(0, SAMPLE_LIMIT);
  return { count: a.count + b.count, sample };
}

/** Diff derived store into cas state; mirrors reconcileCasInventory (acyclic modules). */
export async function reconcileDerivedInto(opts: {
  cas: StoreReconciliationState;
  db: VaultDb;
  storageConnections?: StorageConnectionStore;
  verifyBucket: boolean;
  live: Set<string>;
  checkedAt: string;
  collect?: typeof collectCasInventory;
}): Promise<void> {
  const collect = opts.collect ?? collectCasInventory;
  const result = await collect({
    db: opts.db,
    ...(opts.storageConnections
      ? { storageConnections: opts.storageConnections }
      : {}),
    verifyBucket: opts.verifyBucket,
    store: "derived",
  });
  if (!result.collection) return; // store not granted — nothing to fold
  const index = new ReplicaIndex(opts.db.vault);
  const rows = index.rows().filter((row) => row.store === "derived");
  const indexed = new Set(rows.map((row) => row.sha256));
  const recentlyIndexed = new Set(
    rows
      .filter((row) => row.replicatedAt >= opts.checkedAt)
      .map((row) => row.sha256)
  );
  const remote = new Set<string>();
  const unknownKeys: string[] = [];
  for (const object of result.collection.objects) {
    if (object.state !== "live") continue;
    const sha = casSha(object.key);
    if (sha) remote.add(sha);
    else unknownKeys.push(object.key);
  }
  // Unmark synchronously so the next eviction cannot trust it.
  const missing = [...indexed].filter(
    (sha) => !remote.has(sha) && !recentlyIndexed.has(sha)
  );
  for (const sha of missing) index.unmark(sha);
  const orphans = [...remote].filter((sha) => !opts.live.has(sha));
  opts.cas.missing = mergeDrift(opts.cas.missing, drift(missing));
  opts.cas.orphans = mergeDrift(
    opts.cas.orphans,
    drift([...orphans, ...unknownKeys])
  );
}
