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

/** Existing local pixels win offline; originals/previews remain on-demand. */
export function pinnedThumbnailUri(
  scopeId: string,
  contentId: string
): string | undefined {
  const directory = packDirectory(scopeId);
  if (!directory) return undefined;
  const file = new File(directory, filename(contentId));
  return file.exists ? file.uri : undefined;
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
  await Promise.all(
    [...byScope].map(async ([scopeId, rows]) => {
      const directory = packDirectory(scopeId);
      if (!directory) return;
      directory.create({ idempotent: true, intermediates: true });
      await [...rows]
        .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
        .reduce(async (previous, row) => {
          await previous;
          const destination = new File(directory, filename(row.contentId));
          if (destination.exists) return;
          await File.downloadFileAsync(row.uri, destination, {
            headers: authHeader(),
            idempotent: true,
          }).catch(() => undefined);
        }, Promise.resolve());
      enforceBudget(directory);
    })
  );
}

export function clearPinnedThumbnailPacks(): void {
  const root = replicaStorageDirectory();
  if (!root) return;
  const directory = new Directory(root, "thumbnail-pack");
  if (directory.exists) directory.delete();
}

export function clearPinnedThumbnailPack(scopeId: string): void {
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
