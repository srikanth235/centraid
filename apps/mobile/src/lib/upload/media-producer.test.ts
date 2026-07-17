// Producer orchestration: the follow-up input mapping, the F11 derivative
// short-circuit, the foreground-service lifecycle, and F6/F10 outcomes. The
// native queue, sealer, imaging and file modules are all injected via mocks so
// the pure orchestration runs under node.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { backupDeviceMedia } from './media-producer';

import type { NativeReplicaSession } from '../replica/native-session';

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
    item?: { itemId: string; sha256: string; state: string; lastError?: string };
  }
  const q: QueueState = {
    existing: undefined,
    finalState: 'settled',
    pendingCount: 1,
    closed: false,
  };
  const fgs = { start: vi.fn(), update: vi.fn(), stop: vi.fn() };
  const deletedFiles: string[] = [];
  const generateDeviceDerivatives = vi.fn();
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

vi.mock('./native-queue', () => ({ UploadQueue: { open: () => H.fakeQueue } }));
vi.mock('./foreground-service', () => ({ UploadForegroundService: H.fgs }));
vi.mock('./derivatives-native', () => ({
  generateDeviceDerivatives: (...args: unknown[]) => H.generateDeviceDerivatives(...args),
}));
vi.mock('./enqueue', () => ({
  sha256OfFile: async () => ({ sha256: 'sha-of-file', size: 1_000 }),
}));
vi.mock('./expo-native', () => ({ expoFileSource: vi.fn() }));
vi.mock('./native-digest', () => ({ createNativeDigest: vi.fn() }));
vi.mock('./followup', () => ({
  replaySettledUploadFollowups: async () => ({ replayed: 0, poisoned: 0 }),
}));
vi.mock('./native-policy', () => ({
  LAST_SUCCESSFUL_SYNC_KEY: 'photos.lastSuccessfulSync',
  nativeUploadPolicy: () => ({ canTransfer: () => true }),
}));
vi.mock('../gateway', () => ({ authHeader: () => ({}) }));
vi.mock('../../storage', () => ({ Store: { set: vi.fn() } }));
vi.mock('expo-file-system', () => ({
  File: class {
    readonly exists = true;
    constructor(readonly uri: string) {}
    delete(): void {
      H.deletedFiles.push(this.uri);
    }
  },
}));

const { q, fgs, deletedFiles, generateDeviceDerivatives } = H;

const session = {} as NativeReplicaSession;

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
    binary: [{ variant: 'thumb', uri: 'file://durable/thumb.jpg', mediaType: 'image/jpeg' }],
    phash: 'phash-value',
    thumbhash: 'thumbhash-value',
  });
  fgs.start.mockClear();
  fgs.stop.mockClear();
});

describe('backupDeviceMedia', () => {
  it('maps device input to the photos follow-up with derivative hashes', async () => {
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
    expect(q.capturedFollowup?.derivatives).toHaveLength(1);
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
    expect(fgs.stop).toHaveBeenCalledTimes(1);
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
    expect(deletedFiles).toEqual(['file://share/IMG.heic']);
  });

  it('leaves the source in place when deletion is not requested', async () => {
    await backupDeviceMedia(session, 'http://gw', {
      localUri: 'file://cam/IMG.heic',
      mediaType: 'image/heic',
      plaintextSize: 1_000,
      kind: 'photo',
    });
    expect(deletedFiles).toEqual([]);
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
    ).rejects.toThrow(/not a paired device/);
    expect(deletedFiles, 'a failed item never deletes its source').toEqual([]);
    expect(fgs.stop, 'the service is still released on failure').toHaveBeenCalledTimes(1);
  });
});
