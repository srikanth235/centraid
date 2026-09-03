import { Directory, File } from "expo-file-system";

import {
  nativeDirectorySize,
  replicaStorageDirectory,
  replicaStorageDirectoryUri,
} from "../../../modules/centraid-storage";
import { OFFLINE_CONTENT_BUDGET_BYTES } from "../../lib/replica/offline-budgets";
import { Store } from "../../storage";
import { planContentEviction } from "./eviction";
import type { StoredContentEntry } from "./eviction";
import { isPinned } from "./pin";
import type { ContentRef, PinnedBytesAnswer } from "./pin";

export { OFFLINE_CONTENT_BUDGET_BYTES } from "../../lib/replica/offline-budgets";

const DIRECTORY_NAME = "offline-content";
const USED_AT_KEY = "fetchGate.contentUsedAt";

export function contentKey(ref: ContentRef): string {
  return `${encodeURIComponent(ref.scopeId)}/${encodeURIComponent(ref.contentId)}`;
}

function filename(contentId: string): string {
  return encodeURIComponent(contentId);
}

export async function hydrateOfflineContent(): Promise<void> {
  await Store.hydrate<Record<string, number>>(USED_AT_KEY, {});
}

function readUsedAt(): Record<string, number> {
  return Store.get<Record<string, number>>(USED_AT_KEY, {});
}

export function touchOfflineContent(ref: ContentRef, now = Date.now()): void {
  Store.set(USED_AT_KEY, { ...readUsedAt(), [contentKey(ref)]: now });
}

function forgetUsedAt(keys: readonly string[]): void {
  if (keys.length === 0) return;
  const next = { ...readUsedAt() };
  for (const key of keys) delete next[key];
  Store.set(USED_AT_KEY, next);
}

function storeRoot(): Directory | undefined {
  const root = replicaStorageDirectoryUri();
  return root ? new Directory(root, DIRECTORY_NAME) : undefined;
}

function scopeDirectory(scopeId: string): Directory | undefined {
  const root = replicaStorageDirectoryUri();
  if (!root) return undefined;
  return new Directory(root, DIRECTORY_NAME, encodeURIComponent(scopeId));
}

function storePath(scopeId?: string): string | undefined {
  const root = replicaStorageDirectory();
  if (!root) return undefined;
  const base = `${root.replace(/\/+$/u, "")}/${DIRECTORY_NAME}`;
  return scopeId ? `${base}/${encodeURIComponent(scopeId)}` : base;
}

let listing: Map<string, string> | undefined;

function index(): Map<string, string> {
  if (listing) return listing;
  const built = new Map<string, string>();
  const root = storeRoot();
  if (!root?.exists) {
    listing = built;
    return built;
  }
  for (const scope of root.list()) {
    if (!(scope instanceof Directory)) continue;
    for (const entry of scope.list())
      if (entry instanceof File)
        built.set(`${scope.name}/${entry.name}`, entry.uri);
  }
  listing = built;
  return built;
}

function invalidateIndex(): void {
  listing = undefined;
}

export function offlineContentUri(ref: ContentRef): string | undefined {
  return index().get(contentKey(ref));
}

export interface StoreContentResult {
  uri: string;
  bytes: number;
}

export async function storeOfflineContent(
  ref: ContentRef,
  url: string,
  headers: Record<string, string>
): Promise<StoreContentResult | undefined> {
  const directory = scopeDirectory(ref.scopeId);
  if (!directory) return undefined;
  directory.create({ idempotent: true, intermediates: true });
  const target = new File(directory, filename(ref.contentId));
  const stored = await File.downloadFileAsync(url, target, {
    headers,
    idempotent: true,
  }).catch(() => undefined);
  if (!stored) return undefined;
  invalidateIndex();
  touchOfflineContent(ref);
  const file = new File(directory, filename(ref.contentId));
  return file.exists ? { uri: file.uri, bytes: file.size } : undefined;
}

export function removeOfflineContent(ref: ContentRef): void {
  const directory = scopeDirectory(ref.scopeId);
  if (!directory?.exists) return;
  const file = new File(directory, filename(ref.contentId));
  if (file.exists) file.delete();
  invalidateIndex();
  forgetUsedAt([contentKey(ref)]);
}

export function removeOfflineContentScope(scopeId: string): void {
  const directory = scopeDirectory(scopeId);
  if (directory?.exists) directory.delete();
  const prefix = `${encodeURIComponent(scopeId)}/`;
  forgetUsedAt(
    Object.keys(readUsedAt()).filter((key) => key.startsWith(prefix))
  );
  invalidateIndex();
}

export function offlineContentBytes(scopeId?: string): number {
  const path = storePath(scopeId);
  if (path === undefined) return 0;
  const native = nativeDirectorySize(path);
  if (native !== undefined) return native;
  const directory = scopeId ? scopeDirectory(scopeId) : storeRoot();
  if (!directory?.exists) return 0;
  return listFiles(directory).reduce((sum, file) => sum + file.size, 0);
}

export function storedContentEntries(): StoredContentEntry[] {
  const usedAt = readUsedAt();
  const root = storeRoot();
  if (!root?.exists) return [];
  const entries: StoredContentEntry[] = [];
  for (const scope of root.list()) {
    if (!(scope instanceof Directory)) continue;
    const scopeId = decodeURIComponent(scope.name);
    for (const file of scope.list()) {
      if (!(file instanceof File)) continue;
      const contentId = decodeURIComponent(file.name);
      const key = `${scope.name}/${file.name}`;
      entries.push({
        key,
        bytes: file.size,
        lastUsedAt: usedAt[key] ?? file.modificationTime ?? 0,
        pinned: isPinned({ scopeId, contentId }),
      });
    }
  }
  return entries;
}

export function enforceOfflineContentBudget(
  budgetBytes: number = OFFLINE_CONTENT_BUDGET_BYTES
): ReturnType<typeof planContentEviction> {
  const entries = storedContentEntries();
  const plan = planContentEviction(entries, budgetBytes);
  if (plan.evict.length === 0) return plan;
  const root = storeRoot();
  if (root?.exists) {
    const byKey = new Map<string, File>(
      root
        .list()
        .flatMap((scope) =>
          scope instanceof Directory
            ? scope
                .list()
                .flatMap((file): [string, File][] =>
                  file instanceof File
                    ? [[`${scope.name}/${file.name}`, file]]
                    : []
                )
            : []
        )
    );
    for (const key of plan.evict) byKey.get(key)?.delete();
  }
  forgetUsedAt(plan.evict);
  invalidateIndex();
  return plan;
}

export function pinnedBytes(): PinnedBytesAnswer {
  if (replicaStorageDirectory() === undefined) {
    return {
      reason:
        "this build has no durable replica directory, so pinned bytes cannot be measured — pin state above is still real",
      status: "unavailable",
    };
  }
  const bytes = storedContentEntries()
    .filter((entry) => entry.pinned)
    .reduce((sum, entry) => sum + entry.bytes, 0);
  return { bytes, status: "known" };
}

function listFiles(directory: Directory): File[] {
  if (!directory.exists) return [];
  return directory
    .list()
    .flatMap((entry) =>
      entry instanceof File
        ? [entry]
        : entry instanceof Directory
          ? listFiles(entry)
          : []
    );
}
