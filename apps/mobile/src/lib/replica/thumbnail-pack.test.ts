// Pinned thumbnail packs: per-source eviction, the native byte total, and the
// transfer policy that governs pack downloads. The expo filesystem, the native
// storage module, and the network policy are injected as mocks, so the pack's
// own accounting runs under node.

/* oxlint-disable max-classes-per-file -- the fake Directory and File are one expo-file-system stand-in; the module under test distinguishes them with `instanceof`, so they cannot be one class (#880) */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { THUMBNAIL_SOURCE_BUDGET_BYTES } from "./offline-budgets";

const ROOT = "/durable/CentraidReplica";
const MIB = 1024 * 1024;

interface DiskFile {
  size: number;
  modificationTime: number;
}

/** Path → file. Directories exist exactly when something lives under them. */
const disk = new Map<string, DiskFile>();
/** Every native sizing crossing, in order — the cost this module is tuned for. */
const nativeSizedPaths: string[] = [];
const storage = {
  replicaStorageDirectory: vi.fn<() => string | undefined>(() => ROOT),
  nativeDirectorySize: vi.fn<(path: string) => number | undefined>((path) =>
    [...disk].reduce(
      (sum, [name, file]) =>
        name.startsWith(`${path}/`) ? sum + file.size : sum,
      0
    )
  ),
};
const policy = { nativeSyncAllowed: vi.fn<() => Promise<boolean>>() };
const downloads: string[] = [];

function join(parts: readonly (string | FakeFile | FakeDirectory)[]): string {
  return parts
    .map((part) => (typeof part === "string" ? part : part.path))
    .join("/")
    .replace(/\/+/gu, "/");
}

function childrenOf(path: string): string[] {
  return [...disk.keys()].filter((name) => name.startsWith(`${path}/`));
}

class FakeDirectory {
  readonly path: string;
  constructor(...parts: (string | FakeFile | FakeDirectory)[]) {
    this.path = join(parts);
  }
  get name(): string {
    return this.path.slice(this.path.lastIndexOf("/") + 1);
  }
  get exists(): boolean {
    return childrenOf(this.path).length > 0;
  }
  create(): void {
    // Directories are implied by their contents in this fake.
  }
  delete(): void {
    for (const name of childrenOf(this.path)) disk.delete(name);
  }
  list(): (FakeFile | FakeDirectory)[] {
    const seen = new Map<string, FakeFile | FakeDirectory>();
    for (const name of childrenOf(this.path)) {
      const rest = name.slice(this.path.length + 1);
      const head = rest.split("/")[0]!;
      const child = `${this.path}/${head}`;
      if (seen.has(child)) continue;
      seen.set(
        child,
        rest.includes("/") ? new FakeDirectory(child) : new FakeFile(child)
      );
    }
    return [...seen.values()];
  }
}

class FakeFile {
  readonly path: string;
  constructor(...parts: (string | FakeFile | FakeDirectory)[]) {
    this.path = join(parts);
  }
  get name(): string {
    return this.path.slice(this.path.lastIndexOf("/") + 1);
  }
  get uri(): string {
    return `file://${this.path}`;
  }
  get exists(): boolean {
    return disk.has(this.path);
  }
  get size(): number {
    return disk.get(this.path)?.size ?? 0;
  }
  get modificationTime(): number {
    return disk.get(this.path)?.modificationTime ?? 0;
  }
  delete(): void {
    disk.delete(this.path);
  }
  static async downloadFileAsync(
    uri: string,
    target: FakeFile
  ): Promise<FakeFile> {
    downloads.push(uri);
    disk.set(target.path, { size: 1, modificationTime: 9_999 });
    return target;
  }
}

vi.mock(import("expo-file-system"), () => ({
  Directory: FakeDirectory as never,
  File: FakeFile as never,
  Paths: {} as never,
}));
vi.mock(import("../../../modules/centraid-storage"), () => ({
  replicaStorageDirectory: () => storage.replicaStorageDirectory(),
  nativeDirectorySize: (path: string) => {
    nativeSizedPaths.push(path);
    return storage.nativeDirectorySize(path);
  },
}));
vi.mock(import("../gateway"), () => ({ authHeader: () => ({}) }));
vi.mock(import("../upload/native-policy"), () => ({
  nativeSyncAllowed: () => policy.nativeSyncAllowed(),
}));

type ThumbnailPack = typeof import("./thumbnail-pack");

/** The module caches its directory listing, so each test gets a fresh copy. */
async function loadPack(): Promise<ThumbnailPack> {
  vi.resetModules();
  return import("./thumbnail-pack");
}

function seed(scopeId: string, files: readonly [string, number, number][]) {
  for (const [contentId, size, modificationTime] of files) {
    disk.set(
      `${ROOT}/thumbnail-pack/${scopeId}/${encodeURIComponent(contentId)}.thumb`,
      { size, modificationTime }
    );
  }
}

function candidate(scopeId: string, contentId: string) {
  return {
    contentId,
    scopeId,
    uri: `https://gateway.test/${contentId}`,
    capturedAt: new Date().toISOString(),
    favorite: true,
  };
}

function packOf(scopeId: string): string[] {
  const prefix = `${ROOT}/thumbnail-pack/${scopeId}/`;
  return [...disk.keys()]
    .filter((name) => name.startsWith(prefix))
    .map((name) => name.slice(prefix.length));
}

describe("pinned thumbnail packs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    disk.clear();
    downloads.length = 0;
    nativeSizedPaths.length = 0;
    storage.replicaStorageDirectory.mockReturnValue(ROOT);
    storage.nativeDirectorySize.mockImplementation((path) =>
      [...disk].reduce(
        (sum, [name, file]) =>
          name.startsWith(`${path}/`) ? sum + file.size : sum,
        0
      )
    );
    policy.nativeSyncAllowed.mockResolvedValue(true);
  });

  it("evicts a source's oldest thumbnails and never reaches into another source", async () => {
    // Three of these overrun the 128 MiB source budget; two fit inside it, so
    // exactly one eviction is due and it must be the oldest.
    const chunk = 50 * MIB;
    seed("alpha", [
      ["oldest", chunk, 1],
      ["middle", chunk, 2],
      ["newest", chunk, 3],
    ]);
    seed("beta", [
      ["beta-old", chunk, 1],
      ["beta-new", chunk, 2],
    ]);
    expect(2 * chunk).toBeLessThanOrEqual(THUMBNAIL_SOURCE_BUDGET_BYTES);
    expect(3 * chunk).toBeGreaterThan(THUMBNAIL_SOURCE_BUDGET_BYTES);
    const pack = await loadPack();

    await pack.refreshPinnedThumbnailPack([candidate("alpha", "fresh")]);

    expect(
      packOf("alpha").sort(),
      "oldest first, only as far as the budget requires"
    ).toStrictEqual(["fresh.thumb", "middle.thumb", "newest.thumb"]);
    expect(
      packOf("beta").sort(),
      "one source's overflow may never cost another its offline pixels"
    ).toStrictEqual(["beta-new.thumb", "beta-old.thumb"]);
  });

  it("leaves a pack inside its budget untouched", async () => {
    seed("alpha", [
      ["old", 4 * MIB, 1],
      ["new", 4 * MIB, 2],
    ]);
    const pack = await loadPack();

    await pack.refreshPinnedThumbnailPack([candidate("alpha", "fresh")]);

    expect(packOf("alpha").sort()).toStrictEqual([
      "fresh.thumb",
      "new.thumb",
      "old.thumb",
    ]);
  });

  it("answers a pack total from one native crossing", async () => {
    seed("alpha", [["one", 2_048, 1]]);
    seed("beta", [["two", 1_024, 1]]);
    const pack = await loadPack();

    expect(pack.thumbnailPackBytes("alpha")).toBe(2_048);
    expect(pack.thumbnailPackBytes(), "every pack when no scope is named").toBe(
      3_072
    );
    expect(
      nativeSizedPaths,
      "one crossing per total, no per-file stat"
    ).toStrictEqual([`${ROOT}/thumbnail-pack/alpha`, `${ROOT}/thumbnail-pack`]);
  });

  it("falls back to a directory walk when the native module is unlinked", async () => {
    seed("alpha", [
      ["one", 2_048, 1],
      ["two", 1_024, 1],
    ]);
    storage.nativeDirectorySize.mockReturnValue(undefined);
    const pack = await loadPack();

    expect(
      pack.thumbnailPackBytes("alpha"),
      "an absent module is not an empty pack"
    ).toBe(3_072);
  });

  it("reports nothing when there is no durable replica directory", async () => {
    storage.replicaStorageDirectory.mockReturnValue(undefined);
    const pack = await loadPack();

    expect(pack.thumbnailPackBytes("alpha")).toBe(0);
  });

  it("refuses to download a pack the transfer policy has not allowed", async () => {
    policy.nativeSyncAllowed.mockResolvedValue(false);
    const pack = await loadPack();

    await pack.refreshPinnedThumbnailPack([candidate("alpha", "fresh")]);

    expect(
      downloads,
      "metered/roaming/charger rules govern these bytes too"
    ).toStrictEqual([]);
    expect(packOf("alpha")).toStrictEqual([]);
  });

  it("never asks the policy when every candidate is already on disk", async () => {
    seed("alpha", [["fresh", 1, 1]]);
    const pack = await loadPack();

    await pack.refreshPinnedThumbnailPack([candidate("alpha", "fresh")]);

    expect(policy.nativeSyncAllowed).not.toHaveBeenCalled();
    expect(downloads).toStrictEqual([]);
  });
});
