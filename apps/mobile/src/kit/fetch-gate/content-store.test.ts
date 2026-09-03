/* oxlint-disable max-classes-per-file -- the fake Directory and File are one expo-file-system stand-in; the module under test distinguishes them with `instanceof`, so they cannot be one class */

import { beforeEach, describe, expect, test, vi } from "vitest";

const ROOT = "/durable/CentraidReplica";

interface DiskFile {
  size: number;
  modificationTime: number;
}

const disk = new Map<string, DiskFile>();
const downloads: string[] = [];
const storage = {
  replicaStorageDirectory: vi.fn<() => string | undefined>(() => ROOT),
};

function join(parts: readonly (string | FakeFile | FakeDirectory)[]): string {
  const [head, ...rest] = parts;
  if (typeof head === "string" && !head.startsWith("file://"))
    throw new Error("URI is not absolute");
  const base =
    typeof head === "string"
      ? head.slice("file://".length)
      : (head?.path ?? "");
  return [
    base,
    ...rest.map((part) => (typeof part === "string" ? part : part.path)),
  ]
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
  create(): void {}
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
        rest.includes("/")
          ? new FakeDirectory(`file://${child}`)
          : new FakeFile(`file://${child}`)
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
  ): Promise<FakeFile | undefined> {
    downloads.push(uri);
    if (uri.includes("broken")) throw new Error("gateway said no");
    disk.set(target.path, { size: downloadSize, modificationTime: 9_999 });
    return target;
  }
}

let downloadSize = 10;

vi.mock(import("expo-file-system"), () => ({
  Directory: FakeDirectory as never,
  File: FakeFile as never,
  Paths: {} as never,
}));
vi.mock(import("../../../modules/centraid-storage"), () => ({
  replicaStorageDirectory: () => storage.replicaStorageDirectory(),
  replicaStorageDirectoryUri: () => {
    const path = storage.replicaStorageDirectory();
    return path === undefined ? undefined : `file://${path}`;
  },
  nativeDirectorySize: () => undefined,
}));
vi.mock(
  import("@react-native-async-storage/async-storage"),
  () =>
    ({
      default: {
        getItem: vi.fn<() => Promise<string | null>>(async () => null),
        removeItem: vi.fn<() => Promise<void>>(async () => undefined),
        setItem: vi.fn<() => Promise<void>>(async () => undefined),
      },
    }) as never
);

type ContentStore = typeof import("./content-store");
type Pin = typeof import("./pin");

async function load(): Promise<{ store: ContentStore; pin: Pin }> {
  vi.resetModules();
  const pin = await import("./pin");
  await pin.hydratePinnedContent();
  const store = await import("./content-store");
  await store.hydrateOfflineContent();
  return { pin, store };
}

const REF_A = { scopeId: "vault-1", contentId: "doc-a" };
const REF_B = { scopeId: "vault-1", contentId: "doc-b" };
const REF_OTHER_SCOPE = { scopeId: "vault-2", contentId: "doc-a" };

describe("the offline byte store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    disk.clear();
    downloads.length = 0;
    downloadSize = 10;
    storage.replicaStorageDirectory.mockReturnValue(ROOT);
  });

  describe("storing and reading back", () => {
    test("stored bytes answer from disk, with no second fetch", async () => {
      const { store } = await load();
      const stored = await store.storeOfflineContent(
        REF_A,
        "https://gateway.test/doc-a",
        {}
      );
      expect(stored?.bytes).toBe(10);
      expect(store.offlineContentUri(REF_A)).toBe(stored?.uri);
      expect(downloads).toHaveLength(1);
    });

    test("an absent ref answers undefined, never an empty file", async () => {
      const { store } = await load();
      expect(store.offlineContentUri(REF_A)).toBeUndefined();
    });

    test("a failed download stores nothing", async () => {
      const { store } = await load();
      const stored = await store.storeOfflineContent(
        REF_A,
        "https://gateway.test/broken",
        {}
      );
      expect(stored).toBeUndefined();
      expect(store.offlineContentUri(REF_A)).toBeUndefined();
    });

    test("the same content id in another vault is another ref", async () => {
      const { store } = await load();
      await store.storeOfflineContent(REF_A, "https://gateway.test/a", {});
      expect(store.offlineContentUri(REF_OTHER_SCOPE)).toBeUndefined();
    });
  });

  describe("the budget pass respects pins", () => {
    test("a pinned item survives a pass that removes its unpinned peers", async () => {
      const { pin, store } = await load();
      downloadSize = 60;
      await store.storeOfflineContent(REF_A, "https://gateway.test/a", {});
      pin.pinContent(REF_A);
      store.touchOfflineContent(REF_A, 1_000);
      await store.storeOfflineContent(REF_B, "https://gateway.test/b", {});
      store.touchOfflineContent(REF_B, 2_000);

      const plan = store.enforceOfflineContentBudget(100);

      expect(plan.evict).toHaveLength(1);
      expect(store.offlineContentUri(REF_A)).toBeDefined();
      expect(store.offlineContentUri(REF_B)).toBeUndefined();
    });

    test("pins alone over budget stay on disk and the plan says so", async () => {
      const { pin, store } = await load();
      downloadSize = 80;
      await store.storeOfflineContent(REF_A, "https://gateway.test/a", {});
      await store.storeOfflineContent(REF_B, "https://gateway.test/b", {});
      pin.pinContent(REF_A);
      pin.pinContent(REF_B);

      const plan = store.enforceOfflineContentBudget(100);

      expect(plan.evict).toStrictEqual([]);
      expect(plan.overBudgetBy).toBe(60);
      expect(store.offlineContentUri(REF_A)).toBeDefined();
      expect(store.offlineContentUri(REF_B)).toBeDefined();
    });
  });

  describe("byte totals", () => {
    test("pinnedBytes reports only what the pins hold", async () => {
      const { pin, store } = await load();
      downloadSize = 25;
      await store.storeOfflineContent(REF_A, "https://gateway.test/a", {});
      await store.storeOfflineContent(REF_B, "https://gateway.test/b", {});
      pin.pinContent(REF_A);
      expect(store.pinnedBytes()).toStrictEqual({ bytes: 25, status: "known" });
      expect(store.offlineContentBytes()).toBe(50);
    });

    test("no durable directory reports unavailable, never a fabricated zero", async () => {
      const { store } = await load();
      storage.replicaStorageDirectory.mockReturnValue(undefined);
      const answer = store.pinnedBytes();
      expect(answer.status).toBe("unavailable");
      expect(answer).not.toHaveProperty("bytes");
    });

    test("a revoked scope's bytes go with it and no other scope's do", async () => {
      const { store } = await load();
      await store.storeOfflineContent(REF_A, "https://gateway.test/a", {});
      await store.storeOfflineContent(
        REF_OTHER_SCOPE,
        "https://gateway.test/a2",
        {}
      );
      store.removeOfflineContentScope("vault-1");
      expect(store.offlineContentUri(REF_A)).toBeUndefined();
      expect(store.offlineContentUri(REF_OTHER_SCOPE)).toBeDefined();
    });
  });
});
