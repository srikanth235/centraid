/*
 * `materializeSnapshotBlobs` (issue #439 R5) — pull SPECIFIC blob shas out of an
 * already-authenticated snapshot and write them into a vault's on-disk blob
 * store, reusing the EXACT chunk-streaming / decrypt / keyed-id-verify path
 * `restoreSnapshot` uses (`engine.ts`). It exists so the adopt-time inventory
 * reconcile (`recover-reconcile.ts`) can re-pin a blob the provider has dropped
 * WITHOUT re-hydrating the whole vault and without hand-rolling the crypto — the
 * one thing FORMAT.md forbids scattering.
 *
 * The reconcile only ever asks for a handful of shas (the divergence between the
 * restored `blob_replica` index's belief and the provider's live inventory), so
 * this re-opens the one manifest and streams just those entries; a sha the
 * snapshot does NOT carry comes back in `absent` (the reconcile records it lost).
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { unframeChunkPayload } from './compress.js';
import {
  chunkId as computeChunkId,
  decrypt,
  deriveDataKey,
  deriveDedupKey,
  type Keyring,
  masterKeyForEpoch,
} from './crypto.js';
import type { EngineLogger } from './engine-log.js';
import { isSafeEntryPath, type ManifestEntry, openManifest } from './manifest.js';
import type { BackupProvider } from './provider.js';

export interface MaterializeSnapshotBlobsOptions {
  provider: BackupProvider;
  targetId: string;
  keyring: Keyring;
  vaultId: string;
  /** The already-restored snapshot's seq — the same base the reconcile trusts. */
  seq: number;
  /** Content shas to materialize (64-hex). Anything the manifest lacks → `absent`. */
  shas: readonly string[];
  /**
   * The vault directory. Entries are written at `<destDir>/<entry.path>`, i.e.
   * `<destDir>/blobs/sha256/<fan>/<sha>` — exactly where `FsBlobStore(<destDir>/blobs)`
   * looks for them (the same layout `restoreSnapshot` writes).
   */
  destDir: string;
  log?: EngineLogger;
}

export interface MaterializeSnapshotBlobsResult {
  /** Shas whose bytes were streamed to disk and verified against the manifest sha. */
  materialized: string[];
  /** Requested shas the snapshot manifest carries no blob entry for (lost, not re-pinnable). */
  absent: string[];
}

/** The content sha of a blob entry is its path's final segment (`restoreSnapshot`'s convention). */
function blobShaOf(entry: ManifestEntry): string | undefined {
  if (entry.kind !== 'blob') return undefined;
  const sha = entry.path.split('/').pop();
  return sha && /^[0-9a-f]{64}$/.test(sha) ? sha : undefined;
}

export async function materializeSnapshotBlobs(
  opts: MaterializeSnapshotBlobsOptions,
): Promise<MaterializeSnapshotBlobsResult> {
  const wanted = new Set(opts.shas);
  if (wanted.size === 0) return { materialized: [], absent: [] };

  const store = await opts.provider.openDataPlane(opts.targetId, 'backup', 'read');
  const row = await opts.provider.getSnapshot(opts.targetId, opts.seq);
  const opened = openManifest(
    await store.get(row.manifestKey),
    opts.keyring,
    opts.vaultId,
    row.manifestHash,
  );
  const master = masterKeyForEpoch(opts.keyring, opened.public.keyEpoch);
  const dataKey = deriveDataKey(master, opts.vaultId);
  const dedupKey = deriveDedupKey(master, opts.vaultId);

  const bySha = new Map<string, ManifestEntry>();
  for (const entry of opened.entries) {
    const sha = blobShaOf(entry);
    if (sha && wanted.has(sha)) bySha.set(sha, entry);
  }

  const materialized: string[] = [];
  const absent: string[] = [];
  for (const sha of wanted) {
    const entry = bySha.get(sha);
    if (!entry) {
      absent.push(sha);
      continue;
    }
    // Same defensive re-check `restoreSnapshot` applies at the point it touches disk.
    if (!isSafeEntryPath(entry.path)) {
      throw new Error(`materializeSnapshotBlobs: entry path rejected: "${entry.path}"`);
    }
    const dest = path.join(opts.destDir, ...entry.path.split('/'));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const hash = createHash('sha256');
    const handle = await fs.open(dest, 'w');
    try {
      for (const id of entry.chunks) {
        // Unseal → unframe → recompute the keyed id: decompression happens
        // BEFORE the integrity check, exactly as in the restore loop.
        const plain = unframeChunkPayload(decrypt(dataKey, await store.get(`chunks/${id}`)));
        if (computeChunkId(dedupKey, plain) !== id) {
          throw new Error(
            `materializeSnapshotBlobs: chunk integrity mismatch for "${entry.path}" (chunk ${id})`,
          );
        }
        const buf = Buffer.from(plain.buffer, plain.byteOffset, plain.byteLength);
        hash.update(buf);
        await handle.write(buf);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    const actual = hash.digest('hex');
    if (actual !== sha) {
      throw new Error(
        `materializeSnapshotBlobs: "${entry.path}" hash mismatch (expected ${sha}, got ${actual})`,
      );
    }
    opts.log?.info?.(`recover: re-pinned blob ${sha} from the snapshot`);
    materialized.push(sha);
  }
  return { materialized, absent };
}
