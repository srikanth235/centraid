import type { LocalBlobStore } from "../blob/local.js";
import { VaultShareError } from "../errors.js";

export type BlobPlacementMode = "present" | "linked" | "copied";

export interface BlobPlacement {
  sha256: string;
  mode: BlobPlacementMode;
}

export function placeBlob(
  origin: LocalBlobStore,
  audience: LocalBlobStore,
  sha: string
): BlobPlacementMode {
  if (audience.hasSync(sha)) return "present";
  const source = origin.localPathSync?.(sha) ?? null;
  if (source !== null && audience.linkFromSync) {
    const outcome = audience.linkFromSync(sha, source);
    if (outcome === "linked") return "linked";
    if (outcome === "exists") return "present";
  }
  const bytes = origin.getSync(sha);
  if (bytes === null) {
    throw new VaultShareError(
      `cannot share ${sha}: the origin vault holds no local bytes for it (bytes must be resident to be placed)`
    );
  }
  audience.putSync(sha, bytes);
  return "copied";
}
