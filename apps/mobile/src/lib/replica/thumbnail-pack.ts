import { Directory, File } from "expo-file-system";

import {
  nativeDirectorySize,
  replicaStorageDirectory,
} from "../../../modules/centraid-storage";
import { authHeader } from "../gateway";
import { THUMBNAIL_SOURCE_BUDGET_BYTES } from "./offline-budgets";

export { THUMBNAIL_SOURCE_BUDGET_BYTES } from "./offline-budgets";
const RECENT_WINDOW_MS = 90 * 24 * 60 * 60 * 1_000;

/** Stats per event-loop turn while walking a pack: a pack at the 128 MiB
 *  ceiling is ~9,300 files, two crossings each, and doing them in one task
 *  drops frames on whatever surface triggered the refresh. */
const STAT_BATCH = 250;

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

/** Filesystem path of a pack for the native sizer — `Directory.uri` is a
 *  `file://` URI and `directorySize` takes a path, so they do not swap. */
function packPath(scopeId?: string): string | undefined {
  const root = replicaStorageDirectory();
  if (!root) return undefined;
  const base = `${root.replace(/\/+$/u, "")}/thumbnail-pack`;
  return scopeId ? `${base}/${encodeURIComponent(scopeId)}` : base;
}

function filename(contentId: string): string {
  return `${encodeURIComponent(contentId)}.thumb`;
}

/**
 * One directory listing per scope, reused until the pack changes.
 *
 * Asking the filesystem "does this thumbnail exist?" once per photo, on every
 * recompute, is a synchronous `stat` per asset per upload poll. A pack holds at
 * most a few thousand files, so listing each scope once and answering from a
 * map is both cheaper and a single crossing.
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
  if (!replicaStorageDirectory()) return;
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
  const work = [...byScope].flatMap(([scopeId, rows]) => {
    const missing = [...rows]
      .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
      .filter(
        (row) =>
          !known.has(
            `${encodeURIComponent(scopeId)}/${filename(row.contentId)}`
          )
      );
    return missing.length > 0 ? [{ scopeId, missing }] : [];
  });
  if (work.length === 0) return;
  // A pack download is bytes over the same radio as the upload drain, so it
  // answers to the same durable policy: Wi-Fi-only, metered, roaming and
  // charger rules decide, never "it is only thumbnails". Imported here rather
  // than at the top so the battery/network modules behind the policy load only
  // when bytes are actually about to move — every surface that merely READS a
  // pack goes through this module too.
  const { nativeSyncAllowed } = await import("../upload/native-policy");
  if (!(await nativeSyncAllowed())) return;
  await Promise.all(
    work.map(async ({ scopeId, missing }) => {
      const directory = packDirectory(scopeId);
      if (!directory) return;
      directory.create({ idempotent: true, intermediates: true });
      await downloadWithConcurrency(missing, directory);
      await enforceBudget(scopeId, directory);
    })
  );
  invalidateIndex();
}

/**
 * Newest-first thumbnails, a few at a time.
 *
 * Downloading strictly one after another makes a first sync on a 90-day window
 * wait out thousands of sequential round trips before the grid has any local
 * pixels. Filling the pipe with a small number of parallel
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
  invalidateIndex();
  const directory = rootPackDirectory();
  if (directory?.exists) directory.delete();
}

export function clearPinnedThumbnailPack(scopeId: string): void {
  invalidateIndex();
  const directory = packDirectory(scopeId);
  if (directory?.exists) directory.delete();
}

/**
 * Bytes in one scope's pack, or in every pack when `scopeId` is omitted. A
 * total is all this answers, so it takes the native one-crossing walk instead
 * of statting up to ~9,300 files on the JS thread; the JavaScript listing
 * survives only as the fallback for a build without the native module.
 */
export function thumbnailPackBytes(scopeId?: string): number {
  const path = packPath(scopeId);
  if (path === undefined) return 0;
  const native = nativeDirectorySize(path);
  if (native !== undefined) return native;
  const directory = scopeId ? packDirectory(scopeId) : rootPackDirectory();
  if (!directory?.exists) return 0;
  return files(directory).reduce((sum, file) => sum + file.size, 0);
}

/**
 * Oldest-first eviction back under this source's budget. "Are we over?" is a
 * total, so it asks the native sizer in one crossing and returns untouched in
 * the common under-budget case; only the over-budget path pays for the
 * listing, since eviction order needs a per-file modification time no total
 * can supply. The walk stays inside one source's directory, so an overfull
 * pack can only ever evict its own thumbnails.
 */
async function enforceBudget(
  scopeId: string,
  directory: Directory
): Promise<void> {
  invalidateIndex();
  const path = packPath(scopeId);
  const total = path === undefined ? undefined : nativeDirectorySize(path);
  if (total !== undefined && total <= THUMBNAIL_SOURCE_BUDGET_BYTES) return;
  const stats = await statsYielding(directory);
  const ordered = stats.sort(
    (left, right) => left.modificationTime - right.modificationTime
  );
  let bytes = ordered.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of ordered) {
    if (bytes <= THUMBNAIL_SOURCE_BUDGET_BYTES) return;
    bytes -= entry.size;
    entry.file.delete();
  }
}

interface PackFileStat {
  file: File;
  size: number;
  modificationTime: number;
}

/** `Directory.list()` has no asynchronous form, but the per-file crossings are
 *  the bulk of the cost and those are ours to spread across turns. */
async function statsYielding(directory: Directory): Promise<PackFileStat[]> {
  const stats: PackFileStat[] = [];
  for (const file of files(directory)) {
    if (stats.length > 0 && stats.length % STAT_BATCH === 0) {
      // oxlint-disable-next-line no-await-in-loop -- yielding the thread between batches IS the work here; a Promise.all would put every stat back in one task
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }
    stats.push({
      file,
      size: file.size,
      modificationTime: file.modificationTime ?? 0,
    });
  }
  return stats;
}

function rootPackDirectory(): Directory | undefined {
  const root = replicaStorageDirectory();
  return root ? new Directory(root, "thumbnail-pack") : undefined;
}

function files(directory: Directory): File[] {
  if (!directory.exists) return [];
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
