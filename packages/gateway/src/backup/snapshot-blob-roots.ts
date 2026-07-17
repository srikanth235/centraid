/*
 * GC-pins-snapshots reachability (issue #436 §6).
 *
 * NORMATIVE INVARIANT. A client that owns CAS garbage collection MUST treat
 * every blob referenced by any RETAINED (unpruned, still inside the retention
 * window) snapshot manifest as a LIVE GC root — even when that blob is no
 * longer referenced by the live vault model. CAS has no history of its own:
 * the backup class's snapshot manifests ARE the attachment history, so a blob
 * that only a past-but-retained snapshot still names is exactly the byte a
 * recovery-to-N would need. Delete it and the recovery-window number N becomes
 * a lie for the bytes users care most about. This helper is the one place that
 * computes that root set, shared by the observability reconciliation pass and
 * by any future client-owned CAS GC, so the two can never disagree about what
 * "reachable" means.
 *
 * The number N (recovery window) may only ever be surfaced in a UI because
 * this invariant holds: the roots computed here are what make N true.
 *
 * Mirrors `pruneWalGenerations`' manifest-keep-set logic: manifests are opened
 * and AUTHENTICATED (never trusted by bare key), and an unreadable manifest
 * THROWS rather than silently shrinking the root set — deleting a blob because
 * we could not read who references it is exactly backwards.
 */

import {
  openManifest,
  type BackupProvider,
  type Keyring,
  type ManifestEntry,
} from '@centraid/backup';

/**
 * The blob shas a single manifest's entries reference. A `blob` entry's
 * content sha is the final segment of its content-addressed
 * `blobs/sha256/<fan>/<sha>` path — the same parse the restore engine uses to
 * key its lazy-restore `skipBlob` predicate. Only `kind: 'blob'` entries name
 * CAS objects; `db`/`git-bundle`/`seal-key` entries are the snapshot's own
 * parts, not attachments.
 */
export function blobShasFromManifestEntries(entries: readonly ManifestEntry[]): string[] {
  const shas: string[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'blob') continue;
    const sha = entry.path.split('/').pop() ?? '';
    if (/^[0-9a-f]{64}$/.test(sha)) shas.push(sha);
  }
  return shas;
}

/**
 * Every CAS blob sha referenced by a RETAINED snapshot manifest — the live GC
 * root set. `listSnapshots` (default) returns only unpruned rows, so a blob
 * whose last reference was a snapshot that has since aged out of the retention
 * window is (correctly) NOT a root: it is a genuine deletion candidate once no
 * retained snapshot names it.
 *
 * `manifestBlobCache` is a `manifestHash → blob shas` memo. Manifests are
 * immutable and content-addressed, so the caller hands the same Map back every
 * run and only NEW manifests get fetched + opened — the same amortization
 * `pruneWalGenerations` uses for its generation keep-set.
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
  const store = await opts.provider.openDataPlane(opts.targetId, 'backup', 'read');
  for (const row of rows) {
    const cached = cache?.get(row.manifestHash);
    if (cached) {
      for (const sha of cached) roots.add(sha);
      continue;
    }
    let opened;
    try {
      opened = openManifest(
        await store.get(row.manifestKey),
        opts.keyring,
        opts.vaultId,
        row.manifestHash,
      );
    } catch (err) {
      // An unreadable retained manifest must FAIL the root computation, never
      // shrink it: a caller that then deletes "unreferenced" CAS blobs would be
      // deleting bytes it simply failed to prove were still reachable.
      throw new Error(
        `snapshot roots: cannot read manifest seq ${row.seq}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    const shas = blobShasFromManifestEntries(opened.entries);
    for (const sha of shas) roots.add(sha);
    cache?.set(row.manifestHash, shas);
  }
  return roots;
}
