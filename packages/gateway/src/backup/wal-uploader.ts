/*
 * WAL segment drain + remote generation GC (issue #408) — the upload half
 * of the shipper: seal each locally-captured segment/closer with the
 * deterministic /1 crypto (byte-identical retries → plain idempotent PUTs)
 * and delete the local file only after the provider accepted it. Offline
 * simply accumulates locally (the shipper's budget policy owns that);
 * everything drains on the next successful pass — no generation break.
 */

import { promises as fs } from 'node:fs';
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
  type BackupProvider,
  type Keyring,
} from '@centraid/backup';
import type { RuntimeLogger } from '@centraid/app-engine';
import type { VaultPlane } from '../serve/vault-plane.js';

export interface DrainResult {
  uploaded: number;
  bytes: number;
  /** Files removed without upload (backup unconfigured — capture-then-discard). */
  discarded: number;
  /**
   * `"{vaultGeneration}-{journalGeneration}"` → newest pair-marker tick the
   * provider ACCEPTED in this pass. Recorded only after the PUT resolves: the
   * caller stamps it into the next manifest, where it becomes a floor the store
   * is held to, so it must never name an object that did not land.
   */
  markerTips: Record<string, number>;
}

/** The state/manifest key for one base pair — a generation break mints a new one. */
export function walPairKey(vaultGeneration: string, journalGeneration: string): string {
  return `${vaultGeneration}-${journalGeneration}`;
}

/**
 * Discard every captured file. Runs when NO backup backend is configured:
 * the shipper must still tick (its rollovers are what bound the WALs now
 * that autocheckpoint is off everywhere), so its output needs a consumer —
 * without a provider, that consumer is the bin. The moment a backend
 * appears, history starts accumulating for real.
 */
export function discardWalFiles(plane: VaultPlane): DrainResult {
  const shipper = plane.walShipper;
  if (!shipper) return { uploaded: 0, bytes: 0, discarded: 0, markerTips: {} };
  const items = shipper.listUploadable();
  const holedDbs = new Set<Parameters<typeof shipper.noteStreamDiscarded>[0]>();
  for (const item of items) {
    if (item.kind === 'segment') holedDbs.add(item.addr!.db);
    else if (item.kind === 'closer') holedDbs.add(item.closer!.db);
    else {
      // A discarded pair marker holes BOTH streams: without it, the tick it
      // described can never be selected as a coordinated restore point again,
      // so neither database is restorable to it.
      holedDbs.add('vault');
      holedDbs.add('journal');
    }
  }
  // Persist the discard intent BEFORE deleting a byte. A crash after this
  // point is conservative (the generation rolls even if some files remain);
  // the reverse order can lose files while state still calls the base sound.
  for (const db of holedDbs) shipper.noteStreamDiscarded(db);
  for (const item of items) shipper.noteUploaded(item);
  // Deleting captured files punches holes in the LIVE stream — the persisted
  // intent above makes the next backend-enabled pass roll before registration.
  // the moment a backend appears the generation breaks BEFORE its stale
  // base could be registered (a restore of a holed stream silently lands
  // on the base: quiet truncation, the one forbidden outcome).
  return { uploaded: 0, bytes: 0, discarded: items.length, markerTips: {} };
}

/**
 * Seal + upload every captured file for one vault, oldest first.
 *
 * `epochForGeneration` pins each WAL generation to ONE keyring epoch (the
 * caller persists the mapping in backup state and forces generation rolls
 * on rotation): restore derives the segment key from the MANIFEST's
 * `keyEpoch`, so a generation whose tail sealed under a newer epoch than
 * its manifest would turn unreadable at exactly the moment rotation was
 * supposed to protect it.
 */
export async function drainWalFiles(opts: {
  plane: VaultPlane;
  provider: BackupProvider;
  targetId: string;
  keyring: Keyring;
  vaultId: string;
  /** Resolve (and record) the sealing epoch for a WAL generation. */
  epochForGeneration: (generation: string) => number;
  logger: RuntimeLogger;
}): Promise<DrainResult> {
  const shipper = opts.plane.walShipper;
  if (!shipper) return { uploaded: 0, bytes: 0, discarded: 0, markerTips: {} };
  const items = shipper.listUploadable();
  if (items.length === 0) return { uploaded: 0, bytes: 0, discarded: 0, markerTips: {} };
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
  const store = await opts.provider.openDataPlane(opts.targetId, 'backup', 'read-write');
  // A pass that throws part-way loses the tips it had gathered — deliberately
  // fine: the tip only ever UNDER-claims then, and the next successful drain
  // (which ships a newer marker) overtakes it. Over-claiming is the failure that
  // would matter, and it is unreachable from here.
  const markerTips: Record<string, number> = {};
  let uploaded = 0;
  let bytes = 0;
  // Sequential and ordered (listUploadable sorts old generations/groups
  // first; within a group, numeric segment names sort before `closed-…`):
  // a failure mid-pass leaves a clean prefix uploaded and the rest local.
  for (const item of items) {
    let sealed: Uint8Array;
    if (item.kind === 'segment') {
      sealed = sealWalSegment(
        dataKeyFor(item.addr!.generation),
        opts.vaultId,
        item.addr!,
        await fs.readFile(item.file),
      );
    } else if (item.kind === 'closer') {
      sealed = sealWalCloser(dataKeyFor(item.closer!.generation), opts.vaultId, item.closer!);
    } else {
      // A pair marker names BOTH generations, so it can only be sealed under
      // ONE epoch — and it must be the epoch its manifest names, or restore
      // (which derives the key from the manifest's `keyEpoch`) cannot open it.
      // The generations always break TOGETHER (`coordinatedBreak`), and a
      // key-epoch rotation forces exactly such a break, so both are always
      // pinned to the same epoch. ASSERT it rather than assume: a mismatch
      // would mean the coordination invariant broke somewhere upstream, and
      // sealing under the wrong key would only surface at restore time.
      const marker = item.marker!;
      const vaultEpoch = opts.epochForGeneration(marker.vaultGeneration);
      const journalEpoch = opts.epochForGeneration(marker.journalGeneration);
      if (vaultEpoch !== journalEpoch) {
        throw new Error(
          `wal drain: pair marker ${item.key} spans key epochs (vault ${vaultEpoch}, ` +
            `journal ${journalEpoch}) — the two generations must break together and pin to one ` +
            'epoch; refusing to seal a marker its manifest could not open',
        );
      }
      sealed = sealWalPairMarker(dataKeyFor(marker.vaultGeneration), opts.vaultId, marker);
    }
    await store.put(item.key, sealed);
    if (item.kind === 'marker') {
      // AFTER the PUT resolved, never before. This number becomes a floor the
      // provider is held to at every later verification — claiming a marker
      // that did not land would turn an interrupted drain into a permanent
      // false alarm, and a check that cries wolf is a check the operator learns
      // to ignore.
      const marker = item.marker!;
      const key = walPairKey(marker.vaultGeneration, marker.journalGeneration);
      markerTips[key] = Math.max(markerTips[key] ?? -1, marker.tickMs);
    }
    shipper.noteUploaded(item);
    uploaded++;
    bytes += sealed.length;
  }
  return { uploaded, bytes, discarded: 0, markerTips };
}

/**
 * Delete remote WAL objects of generations no registered snapshot
 * references — client-side GC (the provider prunes REGISTRY rows, never
 * objects it can't parse). Two keep-sets guard it:
 * - every generation referenced by an unpruned snapshot manifest (opened
 *   and authenticated — we never trust bare keys for retention decisions);
 * - every generation the shipper currently writes (its base may not be
 *   registered yet — deleting live segments in that window would destroy
 *   the newest restore points).
 */
export async function pruneWalGenerations(opts: {
  plane: VaultPlane;
  provider: BackupProvider;
  targetId: string;
  keyring: Keyring;
  vaultId: string;
  /**
   * `manifestHash → referenced walGenerations` memo. Manifests are
   * immutable and content-addressed, so the caller (BackupService) hands
   * the same Map back every run and only NEW manifests get fetched.
   */
  manifestGenerationCache?: Map<string, string[]>;
  logger: RuntimeLogger;
}): Promise<{ deletedObjects: number; keptGenerations: Set<string> }> {
  const shipper = opts.plane.walShipper;
  const keep = new Set<string>();
  if (shipper) for (const base of shipper.currentBases()) keep.add(base.generation);

  const cache = opts.manifestGenerationCache;
  const rows = await opts.provider.listSnapshots(opts.targetId);
  const store = await opts.provider.openDataPlane(opts.targetId, 'backup', 'read-write');
  for (const row of rows) {
    const cached = cache?.get(row.manifestHash);
    if (cached) {
      for (const gen of cached) keep.add(gen);
      continue;
    }
    try {
      const bytes = await store.get(row.manifestKey);
      const opened = openManifest(bytes, opts.keyring, opts.vaultId, row.manifestHash);
      const generations: string[] = [];
      for (const entry of opened.entries) {
        if (entry.walGeneration !== undefined) {
          keep.add(entry.walGeneration);
          generations.push(entry.walGeneration);
        }
      }
      cache?.set(row.manifestHash, generations);
    } catch (err) {
      // An unreadable manifest must FAIL the prune, not shrink the keep
      // set — deleting segments because we couldn't read who references
      // them is exactly backwards.
      throw new Error(
        `wal prune: cannot read manifest seq ${row.seq}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  let deletedObjects = 0;
  for (const db of WAL_DB_NAMES) {
    const doomed: string[] = [];
    for await (const obj of store.list(walDbPrefix(db))) {
      const gen = parseWalSegmentKey(obj.key)?.generation ?? parseWalCloserKey(obj.key)?.generation;
      if (gen !== undefined && !keep.has(gen)) doomed.push(obj.key);
    }
    for (const key of doomed) {
      await store.delete(key);
      deletedObjects++;
    }
  }
  // Pair markers live outside the per-db prefixes (their key names BOTH
  // generations) — a separate pass, or they would accumulate forever. A marker
  // is dead the moment EITHER of its generations is: it can only ever be used
  // by a restore of exactly that pair.
  const doomedMarkers: string[] = [];
  for await (const obj of store.list(walPairMarkerRootPrefix())) {
    const addr = parseWalPairMarkerKey(obj.key);
    if (!addr) continue;
    if (!keep.has(addr.vaultGeneration) || !keep.has(addr.journalGeneration)) {
      doomedMarkers.push(obj.key);
    }
  }
  for (const key of doomedMarkers) {
    await store.delete(key);
    deletedObjects++;
  }
  if (deletedObjects > 0) {
    opts.logger.info(
      `backup: pruned ${deletedObjects} wal object(s) from unreferenced generations`,
    );
  }
  return { deletedObjects, keptGenerations: keep };
}
