// Producer orchestration: the follow-up input mapping, the derivative
// short-circuit, the foreground-service lifecycle, and the settle outcomes. The
// native queue, sealer, imaging and file modules are all injected via mocks so
// the pure orchestration runs under node.

import { rmSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import type { NativeReplicaSession } from "../replica/native-session";
import type { PendingUploadGroup } from "../replica/storage-accounting";
import type * as TypeImport_1mtgsk8 from "./derivatives-native";
import type * as TypeImport_tjnyu from "./expo-native";
import { backupDeviceMedia } from "./media-producer";
import type * as TypeImport_181nh9s from "./native-digest";
import { NodeSqliteFileDriver } from "./node-sqlite-driver";
import { PENDING_PAGE_LIMIT, UploadQueueStore } from "./store";

type ExpoFileSystem = typeof import("expo-file-system");
type StorageModule = typeof import("../../storage");
type ForegroundServiceModule = typeof import("./foreground-service");
type NativeQueueModule = typeof import("./native-queue");

// Shared, mutable fakes — hoisted so the (hoisted) vi.mock factories can close
// over them without a temporal-dead-zone reference.
const H = vi.hoisted(() => {
  interface QueueState {
    existing: unknown;
    finalState: string;
    lastError?: string;
    pendingGroups: PendingUploadGroup[];
    unfinishedFollowup: boolean;
    capturedInput?: Record<string, unknown>;
    capturedFollowup?: Record<string, unknown>;
    closed: boolean;
    item?: {
      itemId: string;
      sha256: string;
      state: string;
      lastError?: string;
    };
  }
  const q: QueueState = {
    existing: undefined,
    finalState: "settled",
    pendingGroups: [{ bytes: 100, itemCount: 1, videoCount: 0 }],
    unfinishedFollowup: false,
    closed: false,
  };
  /** Every denominator the notification was started with, in order. */
  const foregroundTotals: number[] = [];
  const fgs = {
    start: vi.fn<ForegroundServiceModule["UploadForegroundService"]["start"]>(
      (total) => {
        foregroundTotals.push(total);
      }
    ),
    update:
      vi.fn<ForegroundServiceModule["UploadForegroundService"]["update"]>(),
    stop: vi.fn<ForegroundServiceModule["UploadForegroundService"]["stop"]>(),
  };
  const deletedFiles: string[] = [];
  const generateDeviceDerivatives =
    vi.fn<typeof TypeImport_1mtgsk8.generateDeviceDerivatives>();
  const fakeQueue = {
    bySha: () => q.item ?? q.existing,
    enqueue: async (
      input: Record<string, unknown>,
      makeFollowup?: (addressed: { sha256: string }) => Record<string, unknown>
    ) => {
      q.capturedInput = input;
      const digest = input.digest as { sha256: string } | undefined;
      q.item = {
        itemId: "item-x",
        sha256: digest?.sha256 ?? "sha",
        state: q.finalState,
        ...(q.lastError ? { lastError: q.lastError } : {}),
      };
      if (makeFollowup)
        q.capturedFollowup = makeFollowup({ sha256: q.item.sha256 });
      return q.item;
    },
    pendingStorageGroups: () => q.pendingGroups,
    drain: async () => ({ settled: 1, deduped: 0, failed: 0, halted: false }),
    hasFollowupForItem: () => q.unfinishedFollowup,
    close: () => {
      q.closed = true;
    },
  };
  return {
    q,
    fgs,
    foregroundTotals,
    deletedFiles,
    generateDeviceDerivatives,
    fakeQueue,
  };
});

vi.mock(import("./native-queue"), () => ({
  // `UploadQueue` has a private constructor and private fields, so it's
  // nominally typed — no plain object (however matching its public surface)
  // can be structurally assignable to it. The test only calls the static
  // `open()` factory, so assert that surface to the real type.
  UploadQueue: {
    open: () => H.fakeQueue,
  } as unknown as NativeQueueModule["UploadQueue"],
}));
vi.mock(import("./foreground-service"), () => ({
  UploadForegroundService: H.fgs,
}));
vi.mock(import("./derivatives-native"), () => ({
  generateDeviceDerivatives: H.generateDeviceDerivatives,
}));
vi.mock(import("./enqueue"), () => ({
  sha256OfFile: async () => ({ sha256: "sha-of-file", size: 1_000 }),
}));
vi.mock(import("./expo-native"), () => ({
  expoFileSource: vi.fn<typeof TypeImport_tjnyu.expoFileSource>(),
}));
vi.mock(import("./native-digest"), () => ({
  createNativeDigest: vi.fn<typeof TypeImport_181nh9s.createNativeDigest>(),
}));
vi.mock(import("./followup"), () => ({
  replaySettledUploadFollowups: async () => ({ replayed: 0, poisoned: 0 }),
}));
vi.mock(import("./native-policy"), () => ({
  // The real export is a `'photos.lastSuccessfulSync'` string-literal const;
  // an unannotated string here would widen to `string`.
  LAST_SUCCESSFUL_SYNC_KEY: "photos.lastSuccessfulSync" as const,
  nativeUploadPolicy: () => ({ canTransfer: () => true }),
}));
vi.mock(import("../gateway"), () => ({ authHeader: () => ({}) }));
vi.mock(import("../../storage"), () => ({
  Store: {
    // Only `set` is called by media-producer.ts, but `Store`'s real shape
    // also has `get`/`hydrate` — implement them with matching signatures
    // (rather than asserting) since they're trivial to satisfy honestly.
    get: <T>(_key: string, fallback: T): T => fallback,
    hydrate: async <T>(_key: string, fallback: T): Promise<T> => fallback,
    set: vi.fn<StorageModule["Store"]["set"]>(),
  },
}));
vi.mock(import("expo-file-system"), () => ({
  // expo-file-system's `File` is a native-backed class with many members
  // (downloadFileAsync, pickFileAsync, streams, …) this test never touches
  // — only the constructor plus `.exists`/`.delete()` are exercised — so the
  // narrow stand-in is asserted to the real type rather than widening it.
  File: class {
    readonly exists = true;
    constructor(readonly uri: string) {}
    delete(): void {
      H.deletedFiles.push(this.uri);
    }
  } as unknown as ExpoFileSystem["File"],
}));

const { q, fgs, foregroundTotals, deletedFiles, generateDeviceDerivatives } = H;

const session = {} as NativeReplicaSession;

/**
 * Group rows produced by the real store rather than written by hand, so the
 * foreground-service denominator is whatever SQL actually answers for a
 * backlog this deep — a `pending()`-shaped read would cap it at one page.
 */
function seedPendingGroups(count: number): PendingUploadGroup[] {
  const dir = tempDirSync("centraid-producer-queue-");
  const driver = new NodeSqliteFileDriver(path.join(dir, "uploads.db"));
  try {
    const store = UploadQueueStore.create(driver);
    for (let index = 0; index < count; index += 1) {
      store.enqueue({
        itemId: `queued-${index}`,
        sha256: index.toString(16).padStart(64, "0"),
        localUri: `file://cam/IMG-${index}.heic`,
        targetVaultId: "vault-personal",
        plaintextSize: 100,
        sealedSize: 227,
        frameCount: 1,
        partCount: 1,
      });
    }
    return store.pendingStorageGroups();
  } finally {
    driver.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("media-producer", () => {
  beforeEach(() => {
    q.existing = undefined;
    q.finalState = "settled";
    q.lastError = undefined;
    q.pendingGroups = [{ bytes: 100, itemCount: 1, videoCount: 0 }];
    q.unfinishedFollowup = false;
    q.capturedInput = undefined;
    q.capturedFollowup = undefined;
    q.closed = false;
    q.item = undefined;
    deletedFiles.length = 0;
    generateDeviceDerivatives.mockReset();
    generateDeviceDerivatives.mockResolvedValue({
      binary: [
        {
          variant: "thumb",
          uri: "file://durable/thumb.jpg",
          mediaType: "image/jpeg",
        },
        {
          variant: "preview",
          uri: "file://durable/preview.jpg",
          mediaType: "image/jpeg",
        },
      ],
      phash: "phash-value",
      thumbhash: "thumbhash-value",
    });
    fgs.start.mockClear();
    fgs.stop.mockClear();
    foregroundTotals.length = 0;
  });

  describe(backupDeviceMedia, () => {
    it("carries C2 client-contributed thumb, preview, pHash, and ThumbHash together", async () => {
      await backupDeviceMedia(session, "http://gw", {
        localUri: "file://cam/IMG.heic",
        filename: "IMG.heic",
        mediaType: "image/heic",
        plaintextSize: 1_000,
        kind: "photo",
        capturedAt: "2026-07-17T00:00:00Z",
        tzOffsetMin: -420,
        width: 4032,
        height: 3024,
      });

      expect(q.capturedFollowup).toMatchObject({
        shape: "photos",
        action: "upload",
        input: {
          staged_sha: "sha-of-file",
          kind: "photo",
          captured_at: "2026-07-17T00:00:00Z",
          tz_offset_min: -420,
          title: "IMG.heic",
          width: 4032,
          height: 3024,
          phash: "phash-value",
          thumbhash: "thumbhash-value",
        },
      });
      const binary = q.capturedFollowup?.derivatives;
      expect(
        Array.isArray(binary)
          ? (binary as Array<{ variant: string }>).map((entry) => entry.variant)
          : []
      ).toStrictEqual(["thumb", "preview"]);
    });

    it("owns the foreground service across the drain and always closes the queue", async () => {
      q.pendingGroups = seedPendingGroups(3);
      await backupDeviceMedia(session, "http://gw", {
        localUri: "file://cam/IMG.heic",
        mediaType: "image/heic",
        plaintextSize: 1_000,
        kind: "photo",
      });
      expect(fgs.start).toHaveBeenCalledWith(3);
      expect(fgs.stop).toHaveBeenCalledOnce();
      expect(q.closed).toBe(true);
    });

    it("counts a backlog deeper than one queue page, not the page", async () => {
      q.pendingGroups = seedPendingGroups(PENDING_PAGE_LIMIT + 3);
      await backupDeviceMedia(session, "http://gw", {
        localUri: "file://cam/IMG.heic",
        mediaType: "image/heic",
        plaintextSize: 1_000,
        kind: "photo",
      });
      expect(
        foregroundTotals,
        "the notification's denominator is the whole queue"
      ).toStrictEqual([PENDING_PAGE_LIMIT + 3]);
    });

    it("skips the derivative pipeline for audio (F11) and for an already-queued sha", async () => {
      await backupDeviceMedia(session, "http://gw", {
        localUri: "file://rec/voice.m4a",
        mediaType: "audio/mp4",
        plaintextSize: 1_000,
        kind: "audio",
      });
      expect(
        generateDeviceDerivatives,
        "audio has no derivatives"
      ).not.toHaveBeenCalled();

      q.existing = { itemId: "old", sha256: "sha-of-file", state: "settled" };
      q.capturedFollowup = undefined;
      await backupDeviceMedia(session, "http://gw", {
        localUri: "file://cam/IMG.heic",
        mediaType: "image/heic",
        plaintextSize: 1_000,
        kind: "photo",
      });
      expect(
        generateDeviceDerivatives,
        "a known sha keeps its first derivatives"
      ).not.toHaveBeenCalled();
      expect(
        q.capturedFollowup,
        "no forked follow-up on an existing row"
      ).toBeUndefined();
    });

    it("deletes the source only when asked and only once the bytes settle (F10)", async () => {
      await backupDeviceMedia(session, "http://gw", {
        localUri: "file://share/IMG.heic",
        mediaType: "image/heic",
        plaintextSize: 1_000,
        kind: "photo",
        deleteSourceAfterSettle: true,
      });
      expect(deletedFiles).toStrictEqual(["file://share/IMG.heic"]);
    });

    it("leaves the source in place when deletion is not requested", async () => {
      await backupDeviceMedia(session, "http://gw", {
        localUri: "file://cam/IMG.heic",
        mediaType: "image/heic",
        plaintextSize: 1_000,
        kind: "photo",
      });
      expect(deletedFiles).toStrictEqual([]);
    });

    it("surfaces a terminal transfer failure instead of a phantom success (F6)", async () => {
      q.finalState = "failed";
      q.lastError = "not a paired device";
      await expect(
        backupDeviceMedia(session, "http://gw", {
          localUri: "file://share/IMG.heic",
          mediaType: "image/heic",
          plaintextSize: 1_000,
          kind: "photo",
          deleteSourceAfterSettle: true,
        })
      ).rejects.toThrow(/not a paired device/u);
      expect(
        deletedFiles,
        "a failed item never deletes its source"
      ).toStrictEqual([]);
      expect(
        fgs.stop,
        "the service is still released on failure"
      ).toHaveBeenCalledOnce();
    });

    it("keeps the source and rejects when the canonical follow-up is unfinished", async () => {
      q.unfinishedFollowup = true;
      await expect(
        backupDeviceMedia(session, "http://gw", {
          localUri: "file://share/IMG.heic",
          mediaType: "image/heic",
          plaintextSize: 1_000,
          kind: "photo",
          deleteSourceAfterSettle: true,
        })
      ).rejects.toThrow(/canonical record was not accepted/u);
      expect(
        deletedFiles,
        "durable bytes are not the same as a published blueprint record"
      ).toStrictEqual([]);
      expect(fgs.stop).toHaveBeenCalledOnce();
    });
  });
});
