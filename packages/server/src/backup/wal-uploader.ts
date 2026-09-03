import { promises as fs } from "node:fs";

import {
  deriveDataKey,
  masterKeyForEpoch,
  openManifest,
  parseWalSegmentKey,
  parseWalCloserKey,
  parseWalTickMarkerKey,
  sealWalCloser,
  sealWalSegment,
  sealWalTickMarker,
  walDbPrefix,
  walTickMarkerRootPrefix,
} from "@centraid/backup";
import type { BackupProvider, Keyring } from "@centraid/backup";
import type { RuntimeLogger } from "@centraid/server/engine";

import type { VaultPlane } from "../serve/vault-plane.js";

export interface DrainResult {
  uploaded: number;
  bytes: number;
  discarded: number;
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

export function discardWalFiles(plane: VaultPlane): DrainResult {
  const shipper = plane.walShipper;
  if (!shipper) return { uploaded: 0, bytes: 0, discarded: 0, markerTips: {} };
  const items = shipper.listUploadable();
  if (items.length > 0) shipper.noteStreamDiscarded();
  for (const item of items) shipper.noteUploaded(item);
  return { uploaded: 0, bytes: 0, discarded: items.length, markerTips: {} };
}

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
      const marker = item.marker!;
      sealed = sealWalTickMarker(
        dataKeyFor(marker.generation),
        opts.vaultId,
        marker
      );
    }
    await store.put(item.key, sealed);
    if (item.kind === "marker") {
      const { generation, tickMs } = item.marker!;
      markerTips[generation] = Math.max(markerTips[generation] ?? -1, tickMs);
    }
    shipper.noteUploaded(item);
    uploaded++;
    bytes += sealed.length;
  });
  return { uploaded, bytes, discarded: 0, markerTips };
}

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
  const live = shipper?.currentBase();
  if (live) keep.add(live.generation);

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
      throw new Error(
        `wal prune: cannot read manifest seq ${row.seq}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  });

  let deletedObjects = 0;
  const doomed: string[] = [];
  await applyAvailableInOrder(store.list(walDbPrefix("vault")), (obj) => {
    const gen =
      parseWalSegmentKey(obj.key)?.generation ??
      parseWalCloserKey(obj.key)?.generation;
    if (gen !== undefined && !keep.has(gen)) doomed.push(obj.key);
  });
  await applyInOrder(doomed, async (key) => {
    await store.delete(key);
    deletedObjects++;
  });
  const doomedMarkers: string[] = [];
  await applyAvailableInOrder(store.list(walTickMarkerRootPrefix()), (obj) => {
    const addr = parseWalTickMarkerKey(obj.key);
    if (addr && !keep.has(addr.generation)) doomedMarkers.push(obj.key);
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
