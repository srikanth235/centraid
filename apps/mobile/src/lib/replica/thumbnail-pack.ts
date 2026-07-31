import { Directory, File } from "expo-file-system";

import { replicaStorageDirectory } from "../../../modules/centraid-storage";
import { authHeader } from "../gateway";
import { THUMBNAIL_SOURCE_BUDGET_BYTES } from "./offline-budgets";

export { THUMBNAIL_SOURCE_BUDGET_BYTES } from "./offline-budgets";
const RECENT_WINDOW_MS = 90 * 24 * 60 * 60 * 1_000;

export interface PinnedThumbnailCandidate {
  contentId: string;
  scopeId: string;
  uri: string;
  capturedAt: string;
  favorite: boolean;
}

function packDirectory(scopeId: string): Directory | undefined {
  const root = replicaStorageDirectory();
  if (!root) return undefined;
  return new Directory(root, "thumbnail-pack", encodeURIComponent(scopeId));
}

function filename(contentId: string): string {
  return `${encodeURIComponent(contentId)}.thumb`;
}

/**
 * One directory listing per scope, reused until the pack changes.
 *
 * The timeline used to ask the filesystem "does this thumbnail exist?" once per
 * photo, on every recompute — a synchronous `stat` per asset per upload poll. A
 * pack holds at most a few thousand files, so listing each scope once and
 * answering from a map is both cheaper and a single crossing.
 */
let packListing: Map<string, string> | undefined;

function packIndex(): Map<string, string> {
  if (packListing) return packListing;
  const built = new Map<string, string>();
  const root = replicaStorageDirectory();
  if (!root) return built;
  const packs = new Directory(root, "thumbnail-pack");
  if (!packs.exists) {
    packListing = built;
    return built;
  }
  for (const scope of packs.list()) {
    if (!(scope instanceof Directory)) continue;
    for (const entry of scope.list()) {
      if (entry instanceof File)
        built.set(`${scope.name}/${entry.name}`, entry.uri);
    }
  }
  packListing = built;
  return built;
}

/**
 * Drop the cached listing. Called whenever this module writes or deletes pack
 * files; a pack cannot change behind its back, since nothing else writes there.
 */
function invalidateIndex(): void {
  packListing = undefined;
}

/** Existing local pixels win offline; originals/previews remain on-demand. */
export function pinnedThumbnailUri(
  scopeId: string,
  contentId: string
): string | undefined {
  return packIndex().get(
    `${encodeURIComponent(scopeId)}/${filename(contentId)}`
  );
}

/**
 * Keep favorites plus the newest 90 days independently for each source.
 * Eviction is source-local and oldest-first, so one family vault cannot crowd
 * another out of its offline budget.
 */
export async function refreshPinnedThumbnailPack(
  candidates: readonly PinnedThumbnailCandidate[]
): Promise<void> {
  const byScope = new Map<string, PinnedThumbnailCandidate[]>();
  const floor = Date.now() - RECENT_WINDOW_MS;
  for (const candidate of candidates) {
    if (!candidate.favorite && Date.parse(candidate.capturedAt) < floor)
      continue;
    byScope.set(candidate.scopeId, [
      ...(byScope.get(candidate.scopeId) ?? []),
      candidate,
    ]);
  }
  const known = packIndex();
  await Promise.all(
    [...byScope].map(async ([scopeId, rows]) => {
      const directory = packDirectory(scopeId);
      if (!directory) return;
      directory.create({ idempotent: true, intermediates: true });
      const missing = [...rows]
        .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
        .filter(
          (row) =>
            !known.has(
              `${encodeURIComponent(scopeId)}/${filename(row.contentId)}`
            )
        );
      await downloadWithConcurrency(missing, directory);
      enforceBudget(directory);
    })
  );
  invalidateIndex();
}

/**
 * Newest-first thumbnails, a few at a time.
 *
 * The pack used to download strictly one after another, so a first sync on a
 * 90-day window waited out thousands of sequential round trips before the grid
 * had any local pixels. Filling the pipe with a small number of parallel
 * requests is a large wall-clock win; keeping the number small is what stops it
 * from starving the foreground reads and the upload drainer sharing the radio.
 */
const PACK_DOWNLOAD_CONCURRENCY = 4;

async function downloadWithConcurrency(
  rows: readonly PinnedThumbnailCandidate[],
  directory: Directory
): Promise<void> {
  let next = 0;
  // Recursive rather than looped: each worker takes the next index, finishes
  // that download, then takes another, so a slow file cannot hold up the pool.
  const worker = async (): Promise<void> => {
    const index = next;
    next += 1;
    const row = rows[index];
    if (!row) return;
    await File.downloadFileAsync(
      row.uri,
      new File(directory, filename(row.contentId)),
      { headers: authHeader(), idempotent: true }
    ).catch(() => undefined);
    return worker();
  };
  await Promise.all(
    Array.from(
      { length: Math.min(PACK_DOWNLOAD_CONCURRENCY, rows.length) },
      worker
    )
  );
}

export function clearPinnedThumbnailPacks(): void {
  const root = replicaStorageDirectory();
  invalidateIndex();
  if (!root) return;
  const directory = new Directory(root, "thumbnail-pack");
  if (directory.exists) directory.delete();
}

export function clearPinnedThumbnailPack(scopeId: string): void {
  invalidateIndex();
  const directory = packDirectory(scopeId);
  if (directory?.exists) directory.delete();
}

export function thumbnailPackBytes(scopeId?: string): number {
  const root = replicaStorageDirectory();
  if (!root) return 0;
  const directory = scopeId
    ? packDirectory(scopeId)
    : new Directory(root, "thumbnail-pack");
  if (!directory?.exists) return 0;
  return files(directory).reduce((sum, file) => sum + file.size, 0);
}

function enforceBudget(directory: Directory): void {
  invalidateIndex();
  const ordered = files(directory).sort(
    (left, right) =>
      (left.modificationTime ?? 0) - (right.modificationTime ?? 0)
  );
  let bytes = ordered.reduce((sum, file) => sum + file.size, 0);
  for (const file of ordered) {
    if (bytes <= THUMBNAIL_SOURCE_BUDGET_BYTES) return;
    bytes -= file.size;
    file.delete();
  }
}

function files(directory: Directory): File[] {
  return directory
    .list()
    .flatMap((entry) =>
      entry instanceof File
        ? [entry]
        : entry instanceof Directory
          ? files(entry)
          : []
    );
}
