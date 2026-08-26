/*
 * materializeSnapshotBlobs (#439): stream specific blob shas from an authenticated snapshot into a
 * vault's blob store via restoreSnapshot's exact decrypt/keyed-id path — recover-reconcile re-pins
 * dropped blobs without re-hydrating or hand-rolling crypto (FORMAT.md). Lacking shas → `absent`.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { unframeChunkPayload } from "./compress.js";
import {
  chunkId as computeChunkId,
  decrypt,
  deriveDataKey,
  deriveDedupKey,
  masterKeyForEpoch,
} from "./crypto.js";
import type { Keyring } from "./crypto.js";
import type { EngineLogger } from "./engine-log.js";
import { isSafeEntryPath, openManifest } from "./manifest.js";
import type { ManifestEntry } from "./manifest.js";
import { applyInOrder } from "./ordered-work.js";
import type { BackupProvider } from "./provider.js";

export interface MaterializeSnapshotBlobsOptions {
  provider: BackupProvider;
  targetId: string;
  keyring: Keyring;
  vaultId: string;
  seq: number;
  shas: readonly string[];
  /** Entries written at `<destDir>/<entry.path>` — where `FsBlobStore(<destDir>/blobs)` looks. */
  destDir: string;
  log?: EngineLogger;
}

export interface MaterializeSnapshotBlobsResult {
  materialized: string[];
  absent: string[];
}

function blobShaOf(entry: ManifestEntry): string | undefined {
  if (entry.kind !== "blob") return undefined;
  const sha = entry.path.split("/").pop();
  return sha && /^[0-9a-f]{64}$/u.test(sha) ? sha : undefined;
}

export async function materializeSnapshotBlobs(
  opts: MaterializeSnapshotBlobsOptions
): Promise<MaterializeSnapshotBlobsResult> {
  const wanted = new Set(opts.shas);
  if (wanted.size === 0) return { materialized: [], absent: [] };

  const store = await opts.provider.openDataPlane(
    opts.targetId,
    "backup",
    "read"
  );
  const row = await opts.provider.getSnapshot(opts.targetId, opts.seq);
  const opened = openManifest(
    await store.get(row.manifestKey),
    opts.keyring,
    opts.vaultId,
    row.manifestHash
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
  await applyInOrder(wanted, async (sha) => {
    const entry = bySha.get(sha);
    if (!entry) {
      absent.push(sha);
      return;
    }
    // Same re-check restoreSnapshot applies at disk-touch time.
    if (!isSafeEntryPath(entry.path)) {
      throw new Error(
        `materializeSnapshotBlobs: entry path rejected: "${entry.path}"`
      );
    }
    const dest = path.join(opts.destDir, ...entry.path.split("/"));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const hash = createHash("sha256");
    const handle = await fs.open(dest, "w");
    try {
      await applyInOrder(entry.chunks, async (id) => {
        // Decompression precedes the integrity check, as in restore.
        const plain = unframeChunkPayload(
          decrypt(dataKey, await store.get(`chunks/${id}`))
        );
        if (computeChunkId(dedupKey, plain) !== id) {
          throw new Error(
            `materializeSnapshotBlobs: chunk integrity mismatch for "${entry.path}" (chunk ${id})`
          );
        }
        const buf = Buffer.from(
          plain.buffer,
          plain.byteOffset,
          plain.byteLength
        );
        hash.update(buf);
        await handle.write(buf);
      });
      await handle.sync();
    } finally {
      await handle.close();
    }
    const actual = hash.digest("hex");
    if (actual !== sha) {
      throw new Error(
        `materializeSnapshotBlobs: "${entry.path}" hash mismatch (expected ${sha}, got ${actual})`
      );
    }
    opts.log?.info?.(`recover: re-pinned blob ${sha} from the snapshot`);
    materialized.push(sha);
  });
  return { materialized, absent };
}
