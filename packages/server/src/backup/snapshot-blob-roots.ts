/*
 * GC-pins-snapshots reachability (#436).
 *
 * A client that owns CAS garbage collection MUST treat every blob referenced
 * by any RETAINED snapshot manifest as a LIVE GC root — even when that blob
 * is no longer in the live vault. CAS has no history of its own: snapshot
 * manifests ARE the attachment history. This helper is the one place that
 * computes that root set, so observability and client-owned CAS GC cannot
 * disagree about "reachable".
 *
 * Manifests are opened and AUTHENTICATED (never trusted by bare key). An
 * unreadable manifest THROWS rather than silently shrinking the root set.
 */

import { openManifest } from "@centraid/backup";
import type { BackupProvider, Keyring, ManifestEntry } from "@centraid/backup";

/**
 * A `blob` entry's content sha is the final path segment of
 * `blobs/sha256/<fan>/<sha>` — the same parse the restore engine uses for
 * `skipBlob`. Only `kind: 'blob'` entries name CAS objects.
 */
export function blobShasFromManifestEntries(
  entries: readonly ManifestEntry[]
): string[] {
  const shas: string[] = [];
  for (const entry of entries) {
    if (entry.kind !== "blob") continue;
    const sha = entry.path.split("/").pop() ?? "";
    if (/^[0-9a-f]{64}$/u.test(sha)) shas.push(sha);
  }
  return shas;
}

/**
 * `listSnapshots` (default) returns only unpruned rows, so a blob whose last
 * reference has aged out of the retention window is NOT a root.
 *
 * `manifestBlobCache` is a `manifestHash → blob shas` memo. Manifests are
 * immutable; hand the same Map back every run so only NEW manifests are
 * fetched.
 */
export async function snapshotReferencedBlobShas(opts: {
  provider: BackupProvider;
  targetId: string;
  keyring: Keyring;
  vaultId: string;
  manifestBlobCache?: Map<string, string[]>;
}): Promise<Set<string>> {
  const roots = new Set<string>();
  const cache = opts.manifestBlobCache;
  const rows = await opts.provider.listSnapshots(opts.targetId);
  const store = await opts.provider.openDataPlane(
    opts.targetId,
    "backup",
    "read"
  );
  const collectNext = async (index: number): Promise<void> => {
    const row = rows[index];
    if (!row) return;
    const cached = cache?.get(row.manifestHash);
    if (cached) {
      for (const sha of cached) roots.add(sha);
      return collectNext(index + 1);
    }
    let opened;
    try {
      opened = openManifest(
        await store.get(row.manifestKey),
        opts.keyring,
        opts.vaultId,
        row.manifestHash
      );
    } catch (error) {
      // Unreadable retained manifest must FAIL the root set, never shrink it.
      throw new Error(
        `snapshot roots: cannot read manifest seq ${row.seq}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
    const shas = blobShasFromManifestEntries(opened.entries);
    for (const sha of shas) roots.add(sha);
    cache?.set(row.manifestHash, shas);
    return collectNext(index + 1);
  };
  await collectNext(0);
  return roots;
}
