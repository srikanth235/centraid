import { File } from 'expo-file-system';

import type { NativeReplicaSession } from '../replica/native-session';
import { authHeader } from '../gateway';
import { withDrainLock } from './drain-lock';
import { generateDeviceDerivatives } from './derivatives-native';
import { sha256OfFile } from './enqueue';
import { expoFileSource } from './expo-native';
import { replaySettledUploadFollowups } from './followup';
import { UploadForegroundService } from './foreground-service';
import { createNativeDigest } from './native-digest';
import { UploadQueue } from './native-queue';
import { LAST_SUCCESSFUL_SYNC_KEY, nativeUploadPolicy } from './native-policy';
import { Store } from '../../storage';

export interface DeviceMediaInput {
  localUri: string;
  filename?: string;
  mediaType: string;
  plaintextSize: number;
  kind: 'photo' | 'video' | 'audio' | 'scan';
  capturedAt?: string;
  tzOffsetMin?: number;
  captureGroupId?: string;
  width?: number;
  height?: number;
  durationS?: number;
  /**
   * F10: delete the source file once its bytes settle durably (and its
   * follow-up is recorded). Set by the share-intent ingest, whose copies in the
   * OS share container would otherwise leak forever. Off by default — a
   * camera-roll original is never deleted.
   */
  deleteSourceAfterSettle?: boolean;
}

export interface BackupDocumentInput {
  localUri: string;
  title: string;
  mediaType: string;
  plaintextSize: number;
  folderId?: string;
  /** F10: see {@link DeviceMediaInput.deleteSourceAfterSettle}. */
  deleteSourceAfterSettle?: boolean;
}

function openQueue(gatewayBase: string): UploadQueue {
  return UploadQueue.open({
    gatewayBaseUrl: gatewayBase,
    headers: authHeader,
    policy: nativeUploadPolicy(),
    onProgress: ({ completed, total }) => UploadForegroundService.update(completed, total),
  });
}

/**
 * Drain and replay under the shared single-flight lock, so a producer never
 * runs concurrently with the reconciler or another producer (F8). The producer
 * OWNS the foreground service across this call (refcounted), and surfaces a
 * terminal transfer failure to its caller instead of returning a phantom
 * success over a stuck row (F6).
 */
async function drainToSettlement(
  session: NativeReplicaSession,
  gatewayBase: string,
  queue: UploadQueue,
  sha256: string,
  source: { localUri: string; deleteAfterSettle: boolean },
): Promise<string> {
  await withDrainLock(async () => {
    // Own the foreground service only for the exclusive drain, so it reflects
    // the transfer actually in flight and a concurrent reconcile (which never
    // starts it) cannot poke a notification it does not own.
    UploadForegroundService.start(queue.pending().length);
    try {
      const summary = await queue.drain();
      if (summary.settled + summary.deduped > 0)
        Store.set(LAST_SUCCESSFUL_SYNC_KEY, new Date().toISOString());
      await replaySettledUploadFollowups(queue, session, gatewayBase);
    } finally {
      UploadForegroundService.stop();
    }
  });
  const item = queue.bySha(sha256);
  if (item?.state === 'failed') {
    throw new Error(`backup of ${sha256} did not settle: ${item.lastError ?? 'unknown error'}`);
  }
  if (source.deleteAfterSettle && item?.state === 'settled') deleteSource(source.localUri);
  return sha256;
}

/** The bytes are durable in CAS; the share-container copy is now redundant. */
function deleteSource(localUri: string): void {
  try {
    const file = new File(localUri);
    if (file.exists) file.delete();
  } catch {
    // A leaked share-container temp is a cosmetic loss, never a correctness one.
  }
}

/**
 * First producer for the durable queue. Re-running after any process death is
 * safe: enqueue dedupes by sha, direct begin dedupes in CAS, derivative slots
 * upsert by (parent, variant), and the replica intent is payload-idempotent.
 */
export async function backupDeviceMedia(
  session: NativeReplicaSession,
  gatewayBase: string,
  input: DeviceMediaInput,
): Promise<string> {
  const queue = openQueue(gatewayBase);
  try {
    // F11: address the bytes ONCE and probe the ledger. A sha the queue has
    // seen keeps the derivatives it was first enqueued with, so re-scanning a
    // library of settled photos pays a hash and a lookup — not N resize/encode
    // pipelines.
    const digest = await sha256OfFile(expoFileSource, input.localUri, createNativeDigest);
    const isNew = queue.bySha(digest.sha256) === undefined;
    const derivatives =
      isNew && input.kind !== 'audio'
        ? await generateDeviceDerivatives(input.localUri, input.mediaType)
        : undefined;
    const item = await queue.enqueue(
      {
        localUri: input.localUri,
        mediaType: input.mediaType,
        ...(input.filename ? { filename: input.filename } : {}),
        plaintextSize: input.plaintextSize,
        digest,
      },
      // Only a brand-new sha attaches a follow-up here; an existing row already
      // carries its own, and re-adding one without derivatives would fork it.
      isNew
        ? (addressed) => ({
            shape: 'photos',
            action: 'upload',
            input: {
              staged_sha: addressed.sha256,
              kind: input.kind,
              ...(input.capturedAt ? { captured_at: input.capturedAt } : {}),
              ...(input.tzOffsetMin !== undefined ? { tz_offset_min: input.tzOffsetMin } : {}),
              ...(input.captureGroupId ? { capture_group_id: input.captureGroupId } : {}),
              ...(input.filename ? { title: input.filename } : {}),
              ...(input.width ? { width: input.width } : {}),
              ...(input.height ? { height: input.height } : {}),
              ...(input.durationS !== undefined ? { duration_s: input.durationS } : {}),
              ...(derivatives
                ? { phash: derivatives.phash, thumbhash: derivatives.thumbhash }
                : {}),
            },
            ...(derivatives ? { derivatives: derivatives.binary } : {}),
          })
        : undefined,
    );
    return await drainToSettlement(session, gatewayBase, queue, item.sha256, {
      localUri: input.localUri,
      deleteAfterSettle: input.deleteSourceAfterSettle ?? false,
    });
  } finally {
    queue.close();
  }
}

/** Docs producer: same sha queue and transfer path, different canonical intent. */
export async function backupDocument(
  session: NativeReplicaSession,
  gatewayBase: string,
  input: BackupDocumentInput,
): Promise<string> {
  const queue = openQueue(gatewayBase);
  try {
    const item = await queue.enqueue(
      {
        localUri: input.localUri,
        filename: input.title,
        mediaType: input.mediaType,
        plaintextSize: input.plaintextSize,
      },
      (addressed) => ({
        shape: 'docs',
        action: 'upload',
        input: {
          staged_sha: addressed.sha256,
          title: input.title,
          ...(input.folderId ? { folder_id: input.folderId } : {}),
        },
      }),
    );
    return await drainToSettlement(session, gatewayBase, queue, item.sha256, {
      localUri: input.localUri,
      deleteAfterSettle: input.deleteSourceAfterSettle ?? false,
    });
  } finally {
    queue.close();
  }
}
