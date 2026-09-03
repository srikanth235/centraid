import { openManifest } from "@centraid/backup";
import type { BackupProvider, Keyring, ManifestEntry } from "@centraid/backup";

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
