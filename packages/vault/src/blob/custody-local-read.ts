import type { BlobCache } from './cache.js';
import type { LocalBlobStore } from './local.js';
import type { BlobRange } from './store.js';

export function localBlobPath(local: LocalBlobStore, sha: string): string | null {
  return local.localPathSync?.(sha) ?? null;
}

export function readLocalBlob(
  local: LocalBlobStore,
  cache: BlobCache | undefined,
  sha: string,
  range?: BlobRange,
): Buffer | null {
  const hit = local.getSync(sha, range);
  if (hit && cache) {
    cache.onLocalHit(hit.length);
    cache.access.touch(sha);
  }
  return hit;
}

export function openLocalBlobStream(
  local: LocalBlobStore,
  cache: BlobCache | undefined,
  sha: string,
  range?: BlobRange,
): ReturnType<NonNullable<LocalBlobStore['openReadStreamSync']>> {
  const opened = local.openReadStreamSync?.(sha, range) ?? null;
  if (opened && cache) {
    cache.onLocalHit(opened.range.end - opened.range.start + 1);
    cache.access.touch(sha);
  }
  return opened;
}
