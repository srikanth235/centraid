import { Directory, File } from "expo-file-system";

import {
  nativeDirectorySize,
  replicaStorageDirectory,
  replicaStorageDirectoryUri,
} from "../../../modules/centraid-storage";
import { authHeader } from "../gateway";
import { THUMBNAIL_SOURCE_BUDGET_BYTES } from "./offline-budgets";

export { THUMBNAIL_SOURCE_BUDGET_BYTES } from "./offline-budgets";
const RECENT_WINDOW_MS = 90 * 24 * 60 * 60 * 1_000;

const STAT_BATCH = 250;

export interface PinnedThumbnailCandidate {
  contentId: string;
  scopeId: string;
  uri: string;
  capturedAt: string;
  favorite: boolean;
}

function packDirectory(scopeId: string): Directory | undefined {
  const root = replicaStorageDirectoryUri();
  if (!root) return undefined;
  return new Directory(root, "thumbnail-pack", encodeURIComponent(scopeId));
}

function packPath(scopeId?: string): string | undefined {
  const root = replicaStorageDirectory();
  if (!root) return undefined;
  const base = `${root.replace(/\/+$/u, "")}/thumbnail-pack`;
  return scopeId ? `${base}/${encodeURIComponent(scopeId)}` : base;
}

function filename(contentId: string): string {
  return `${encodeURIComponent(contentId)}.thumb`;
}

let packListing: Map<string, string> | undefined;

function packIndex(): Map<string, string> {
  if (packListing) return packListing;
  const built = new Map<string, string>();
  const root = replicaStorageDirectoryUri();
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

function invalidateIndex(): void {
  packListing = undefined;
}

export function pinnedThumbnailUri(
  scopeId: string,
  contentId: string
): string | undefined {
  return packIndex().get(
    `${encodeURIComponent(scopeId)}/${filename(contentId)}`
  );
}

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

const PACK_DOWNLOAD_CONCURRENCY = 4;

async function downloadWithConcurrency(
  rows: readonly PinnedThumbnailCandidate[],
  directory: Directory
): Promise<void> {
  let next = 0;
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

export function thumbnailPackBytes(scopeId?: string): number {
  const path = packPath(scopeId);
  if (path === undefined) return 0;
  const native = nativeDirectorySize(path);
  if (native !== undefined) return native;
  const directory = scopeId ? packDirectory(scopeId) : rootPackDirectory();
  if (!directory?.exists) return 0;
  return files(directory).reduce((sum, file) => sum + file.size, 0);
}

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
  const root = replicaStorageDirectoryUri();
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
