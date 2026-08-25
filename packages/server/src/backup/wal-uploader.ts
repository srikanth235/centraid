// WAL segment drain + remote generation GC (#408). The deterministic /1 crypto
// makes a retry an idempotent PUT; a local file dies only after acceptance.

import { promises as fs } from "node:fs";

import {
  deriveDataKey,
  masterKeyForEpoch,
  openManifest,
  parseWalPairMarkerKey,
  parseWalSegmentKey,
  parseWalCloserKey,
  sealWalCloser,
  sealWalPairMarker,
  sealWalSegment,
  WAL_DB_NAMES,
  walDbPrefix,
  walPairMarkerRootPrefix,
} from "@centraid/backup";
import type { BackupProvider, Keyring } from "@centraid/backup";
import type { RuntimeLogger } from "@centraid/server/engine";

import type { VaultPlane } from "../serve/vault-plane.js";

export interface DrainResult {
  uploaded: number;
  bytes: number;
  discarded: number;
  /** Recorded only after the PUT resolves: it becomes a floor. */
  markerTips: Record<string, number>;
}

function applyInOrder<T>(
  values: Iterable<T>,
  apply: (value: T, index: number) => void | PromiseLike<void>
): Promise<void> {
  let index = 0;
  return Array.from(values).reduce<Promise<void>>(
    (sequence, value) => sequence.then(() => apply(value, index++)),
    Promise.resolve()
  );
}

async function applyAvailableInOrder<T>(
  values: AsyncIterable<T>,
  apply: (value: T, index: number) => void | PromiseLike<void>
): Promise<void> {
  const iterator = values[Symbol.asyncIterator]();
  async function applyNext(index: number): Promise<void> {
    const next = await iterator.next();
    if (next.done) return;
    await apply(next.value, index);
    return applyNext(index + 1);
  }
  try {
    await applyNext(0);
  } catch (error) {
    await iterator.return?.();
    throw error;
  }
}

export function walPairKey(
  vaultGeneration: string,
  journalGeneration: string
): string {
  return `${vaultGeneration}-${journalGeneration}`;
}

/** Runs when NO backend is configured: the shipper's rollovers bound the WALs,
 *  so its output still needs a consumer. */
export function discardWalFiles(plane: VaultPlane): DrainResult {
  const shipper = plane.walShipper;
  if (!shipper) return { uploaded: 0, bytes: 0, discarded: 0, markerTips: {} };
  const items = shipper.listUploadable();
  const holedDbs = new Set<Parameters<typeof shipper.noteStreamDiscarded>[0]>();
  for (const item of items) {
    if (item.kind === "segment") holedDbs.add(item.addr!.db);
    else if (item.kind === "closer") holedDbs.add(item.closer!.db);
    else {
      // Holes BOTH streams: this tick is no longer a coordinated restore point.
      holedDbs.add("vault");
      holedDbs.add("journal");
    }
  }
  // Intent BEFORE deletion: the reverse order loses files while state calls the
  // base sound.
  for (const db of holedDbs) shipper.noteStreamDiscarded(db);
  for (const item of items) shipper.noteUploaded(item);
  // It breaks the generation before a stale base can be registered: restoring a
  // holed stream lands on the base, which is quiet truncation.
  return { uploaded: 0, bytes: 0, discarded: items.length, markerTips: {} };
}

/** `epochForGeneration` pins a generation to ONE keyring epoch: restore derives
 *  the segment key from the MANIFEST, so a tail sealed under a newer epoch is
 *  unreadable exactly when rotation should protect it. */
export async function drainWalFiles(opts: {
  plane: VaultPlane;
  provider: BackupProvider;
  targetId: string;
  keyring: Keyring;
  vaultId: string;
  epochForGeneration: (generation: string) => number;
  logger: RuntimeLogger;
}): Promise<DrainResult> {
  const shipper = opts.plane.walShipper;
  if (!shipper) return { uploaded: 0, bytes: 0, discarded: 0, markerTips: {} };
  const items = shipper.listUploadable();
  if (items.length === 0)
    return { uploaded: 0, bytes: 0, discarded: 0, markerTips: {} };
  const dataKeyByEpoch = new Map<number, Uint8Array>();
  const dataKeyFor = (generation: string): Uint8Array => {
    const epoch = opts.epochForGeneration(generation);
    let key = dataKeyByEpoch.get(epoch);
    if (!key) {
      key = deriveDataKey(masterKeyForEpoch(opts.keyring, epoch), opts.vaultId);
      dataKeyByEpoch.set(epoch, key);
    }
    return key;
  };
  const store = await opts.provider.openDataPlane(
    opts.targetId,
    "backup",
    "read-write"
  );
  const markerTips: Record<string, number> = {};
  let uploaded = 0;
  let bytes = 0;
  await applyInOrder(items, async (item) => {
    let sealed: Uint8Array;
    if (item.kind === "segment") {
      sealed = sealWalSegment(
        dataKeyFor(item.addr!.generation),
        opts.vaultId,
        item.addr!,
        await fs.readFile(item.file)
      );
    } else if (item.kind === "closer") {
      sealed = sealWalCloser(
        dataKeyFor(item.closer!.generation),
        opts.vaultId,
        item.closer!
      );
    } else {
      // A pair marker seals under ONE epoch — the one its manifest names, or restore
      // cannot open it. Asserted, not assumed.
      const marker = item.marker!;
      const vaultEpoch = opts.epochForGeneration(marker.vaultGeneration);
      const journalEpoch = opts.epochForGeneration(marker.journalGeneration);
      if (vaultEpoch !== journalEpoch) {
        throw new Error(
          `wal drain: pair marker ${item.key} spans key epochs (vault ${vaultEpoch}, ` +
            `journal ${journalEpoch}) — the two generations must break together and pin to one ` +
            "epoch; refusing to seal a marker its manifest could not open"
        );
      }
      sealed = sealWalPairMarker(
        dataKeyFor(marker.vaultGeneration),
        opts.vaultId,
        marker
      );
    }
    await store.put(item.key, sealed);
    if (item.kind === "marker") {
      // AFTER the PUT resolved: this is a floor held to at every verification.
      const marker = item.marker!;
      const key = walPairKey(marker.vaultGeneration, marker.journalGeneration);
      markerTips[key] = Math.max(markerTips[key] ?? -1, marker.tickMs);
    }
    shipper.noteUploaded(item);
    uploaded++;
    bytes += sealed.length;
  });
  return { uploaded, bytes, discarded: 0, markerTips };
}

/** Client-side GC: the provider prunes REGISTRY rows, never objects. Keep every
 *  generation an authenticated manifest references, and every one still being
 *  written. */
export async function pruneWalGenerations(opts: {
  plane: VaultPlane;
  provider: BackupProvider;
  targetId: string;
  keyring: Keyring;
  vaultId: string;
  manifestGenerationCache?: Map<string, string[]>;
  logger: RuntimeLogger;
}): Promise<{ deletedObjects: number; keptGenerations: Set<string> }> {
  const shipper = opts.plane.walShipper;
  const keep = new Set<string>();
  if (shipper)
    for (const base of shipper.currentBases()) keep.add(base.generation);

  const cache = opts.manifestGenerationCache;
  const rows = await opts.provider.listSnapshots(opts.targetId);
  const store = await opts.provider.openDataPlane(
    opts.targetId,
    "backup",
    "read-write"
  );
  await applyInOrder(rows, async (row) => {
    const cached = cache?.get(row.manifestHash);
    if (cached) {
      for (const gen of cached) keep.add(gen);
      return;
    }
    try {
      const bytes = await store.get(row.manifestKey);
      const opened = openManifest(
        bytes,
        opts.keyring,
        opts.vaultId,
        row.manifestHash
      );
      const generations: string[] = [];
      for (const entry of opened.entries) {
        if (entry.walGeneration !== undefined) {
          keep.add(entry.walGeneration);
          generations.push(entry.walGeneration);
        }
      }
      cache?.set(row.manifestHash, generations);
    } catch (error) {
      // An unreadable manifest FAILS the prune, never shrinks the keep set.
      throw new Error(
        `wal prune: cannot read manifest seq ${row.seq}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  });

  let deletedObjects = 0;
  await applyInOrder(WAL_DB_NAMES, async (db) => {
    const doomed: string[] = [];
    await applyAvailableInOrder(store.list(walDbPrefix(db)), (obj) => {
      const gen =
        parseWalSegmentKey(obj.key)?.generation ??
        parseWalCloserKey(obj.key)?.generation;
      if (gen !== undefined && !keep.has(gen)) doomed.push(obj.key);
    });
    await applyInOrder(doomed, async (key) => {
      await store.delete(key);
      deletedObjects++;
    });
  });
  // Pair markers need their own pass; one dies with EITHER generation.
  const doomedMarkers: string[] = [];
  await applyAvailableInOrder(store.list(walPairMarkerRootPrefix()), (obj) => {
    const addr = parseWalPairMarkerKey(obj.key);
    if (!addr) return;
    if (!keep.has(addr.vaultGeneration) || !keep.has(addr.journalGeneration)) {
      doomedMarkers.push(obj.key);
    }
  });
  await applyInOrder(doomedMarkers, async (key) => {
    await store.delete(key);
    deletedObjects++;
  });
  if (deletedObjects > 0) {
    opts.logger.info(
      `backup: pruned ${deletedObjects} wal object(s) from unreferenced generations`
    );
  }
  return { deletedObjects, keptGenerations: keep };
}
