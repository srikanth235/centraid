// Producer orchestration: the follow-up input mapping, the F11 derivative
// short-circuit, the foreground-service lifecycle, and F6/F10 outcomes. The
// native queue, sealer, imaging and file modules are all injected via mocks so
// the pure orchestration runs under node.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NativeReplicaSession } from '../replica/native-session';
import { backupDeviceMedia } from './media-producer';

// Shared, mutable fakes — hoisted so the (hoisted) vi.mock factories can close
// over them without a temporal-dead-zone reference.
const H = vi.hoisted(() => {
  interface QueueState {
    existing: unknown;
    finalState: string;
    lastError?: string;
    pendingCount: number;
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
    finalState: 'settled',
    pendingCount: 1,
    closed: false,
  };
  const fgs = {
    start: vi.fn<typeof import('./foreground-service').UploadForegroundService.start>(),
    update: vi.fn<typeof import('./foreground-service').UploadForegroundService.update>(),
    stop: vi.fn<typeof import('./foreground-service').UploadForegroundService.stop>(),
  };
  const deletedFiles: string[] = [];
  const generateDeviceDerivatives =
    vi.fn<typeof import('./derivatives-native').generateDeviceDerivatives>();
  const fakeQueue = {
    bySha: () => q.item ?? q.existing,
    enqueue: async (
      input: Record<string, unknown>,
      makeFollowup?: (addressed: { sha256: string }) => Record<string, unknown>,
    ) => {
      q.capturedInput = input;
      const digest = input.digest as { sha256: string } | undefined;
      q.item = {
        itemId: 'item-x',
        sha256: digest?.sha256 ?? 'sha',
        state: q.finalState,
        ...(q.lastError ? { lastError: q.lastError } : {}),
      };
      if (makeFollowup) q.capturedFollowup = makeFollowup({ sha256: q.item.sha256 });
      return q.item;
    },
    pending: () => Array.from({ length: q.pendingCount }, () => ({})),
    drain: async () => ({ settled: 1, deduped: 0, failed: 0, halted: false }),
    close: () => {
      q.closed = true;
    },
  };
  return { q, fgs, deletedFiles, generateDeviceDerivatives, fakeQueue };
});

vi.mock(import('./native-queue'), () => ({
  // `UploadQueue` has a private constructor and private fields, so it's
  // nominally typed — no plain object (however matching its public surface)
  // can be structurally assignable to it. The test only calls the static
  // `open()` factory, so assert that surface to the real type.
  UploadQueue: {
    open: () => H.fakeQueue,
  } as unknown as typeof import('./native-queue').UploadQueue,
}));
vi.mock(import('./foreground-service'), () => ({
  UploadForegroundService: H.fgs,
}));
vi.mock(import('./derivatives-native'), () => ({
  generateDeviceDerivatives: H.generateDeviceDerivatives,
}));
vi.mock(import('./enqueue'), () => ({
  sha256OfFile: async () => ({ sha256: 'sha-of-file', size: 1_000 }),
}));
vi.mock(import('./expo-native'), () => ({
  expoFileSource: vi.fn<typeof import('./expo-native').expoFileSource>(),
}));
vi.mock(import('./native-digest'), () => ({
  createNativeDigest: vi.fn<typeof import('./native-digest').createNativeDigest>(),
}));
vi.mock(import('./followup'), () => ({
  replaySettledUploadFollowups: async () => ({ replayed: 0, poisoned: 0 }),
}));
vi.mock(import('./native-policy'), () => ({
  // The real export is a `'photos.lastSuccessfulSync'` string-literal const;
  // an unannotated string here would widen to `string`.
  LAST_SUCCESSFUL_SYNC_KEY: 'photos.lastSuccessfulSync' as const,
  nativeUploadPolicy: () => ({ canTransfer: () => true }),
}));
vi.mock(import('../gateway'), () => ({ authHeader: () => ({}) }));
vi.mock(import('../../storage'), () => ({
  Store: {
    // Only `set` is called by media-producer.ts, but `Store`'s real shape
    // also has `get`/`hydrate` — implement them with matching signatures
    // (rather than asserting) since they're trivial to satisfy honestly.
    get: <T>(_key: string, fallback: T): T => fallback,
    hydrate: async <T>(_key: string, fallback: T): Promise<T> => fallback,
    set: vi.fn<typeof import('../../storage').Store.set>(),
  },
}));
vi.mock(import('expo-file-system'), () => ({
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
  } as unknown as typeof import('expo-file-system').File,
}));

const { q, fgs, deletedFiles, generateDeviceDerivatives } = H;

const session = {} as NativeReplicaSession;

describe('media-producer', () => {
  beforeEach(() => {
    q.existing = undefined;
    q.finalState = 'settled';
    q.lastError = undefined;
    q.pendingCount = 1;
    q.capturedInput = undefined;
    q.capturedFollowup = undefined;
    q.closed = false;
    q.item = undefined;
    deletedFiles.length = 0;
    generateDeviceDerivatives.mockReset();
    generateDeviceDerivatives.mockResolvedValue({
      binary: [
        {
          variant: 'thumb',
          uri: 'file://durable/thumb.jpg',
          mediaType: 'image/jpeg',
        },
        {
          variant: 'preview',
          uri: 'file://durable/preview.jpg',
          mediaType: 'image/jpeg',
        },
      ],
      phash: 'phash-value',
      thumbhash: 'thumbhash-value',
    });
    fgs.start.mockClear();
    fgs.stop.mockClear();
  });

  describe(backupDeviceMedia, () => {
    it('carries C2 client-contributed thumb, preview, pHash, and ThumbHash together', async () => {
      await backupDeviceMedia(session, 'http://gw', {
        localUri: 'file://cam/IMG.heic',
        filename: 'IMG.heic',
        mediaType: 'image/heic',
        plaintextSize: 1_000,
        kind: 'photo',
        capturedAt: '2026-07-17T00:00:00Z',
        tzOffsetMin: -420,
        width: 4032,
        height: 3024,
      });

      expect(q.capturedFollowup).toMatchObject({
        shape: 'photos',
        action: 'upload',
        input: {
          staged_sha: 'sha-of-file',
          kind: 'photo',
          captured_at: '2026-07-17T00:00:00Z',
          tz_offset_min: -420,
          title: 'IMG.heic',
          width: 4032,
          height: 3024,
          phash: 'phash-value',
          thumbhash: 'thumbhash-value',
        },
      });
      const binary = q.capturedFollowup?.derivatives;
      expect(
        Array.isArray(binary)
          ? (binary as Array<{ variant: string }>).map((entry) => entry.variant)
          : [],
      ).toStrictEqual(['thumb', 'preview']);
    });

    it('owns the foreground service across the drain and always closes the queue', async () => {
      q.pendingCount = 3;
      await backupDeviceMedia(session, 'http://gw', {
        localUri: 'file://cam/IMG.heic',
        mediaType: 'image/heic',
        plaintextSize: 1_000,
        kind: 'photo',
      });
      expect(fgs.start).toHaveBeenCalledWith(3);
      expect(fgs.stop).toHaveBeenCalledOnce();
      expect(q.closed).toBe(true);
    });

    it('skips the derivative pipeline for audio (F11) and for an already-queued sha', async () => {
      await backupDeviceMedia(session, 'http://gw', {
        localUri: 'file://rec/voice.m4a',
        mediaType: 'audio/mp4',
        plaintextSize: 1_000,
        kind: 'audio',
      });
      expect(generateDeviceDerivatives, 'audio has no derivatives').not.toHaveBeenCalled();

      q.existing = { itemId: 'old', sha256: 'sha-of-file', state: 'settled' };
      q.capturedFollowup = undefined;
      await backupDeviceMedia(session, 'http://gw', {
        localUri: 'file://cam/IMG.heic',
        mediaType: 'image/heic',
        plaintextSize: 1_000,
        kind: 'photo',
      });
      expect(
        generateDeviceDerivatives,
        'a known sha keeps its first derivatives',
      ).not.toHaveBeenCalled();
      expect(q.capturedFollowup, 'no forked follow-up on an existing row').toBeUndefined();
    });

    it('deletes the source only when asked and only once the bytes settle (F10)', async () => {
      await backupDeviceMedia(session, 'http://gw', {
        localUri: 'file://share/IMG.heic',
        mediaType: 'image/heic',
        plaintextSize: 1_000,
        kind: 'photo',
        deleteSourceAfterSettle: true,
      });
      expect(deletedFiles).toStrictEqual(['file://share/IMG.heic']);
    });

    it('leaves the source in place when deletion is not requested', async () => {
      await backupDeviceMedia(session, 'http://gw', {
        localUri: 'file://cam/IMG.heic',
        mediaType: 'image/heic',
        plaintextSize: 1_000,
        kind: 'photo',
      });
      expect(deletedFiles).toStrictEqual([]);
    });

    it('surfaces a terminal transfer failure instead of a phantom success (F6)', async () => {
      q.finalState = 'failed';
      q.lastError = 'not a paired device';
      await expect(
        backupDeviceMedia(session, 'http://gw', {
          localUri: 'file://share/IMG.heic',
          mediaType: 'image/heic',
          plaintextSize: 1_000,
          kind: 'photo',
          deleteSourceAfterSettle: true,
        }),
      ).rejects.toThrow(/not a paired device/u);
      expect(deletedFiles, 'a failed item never deletes its source').toStrictEqual([]);
      expect(fgs.stop, 'the service is still released on failure').toHaveBeenCalledOnce();
    });
  });
});
