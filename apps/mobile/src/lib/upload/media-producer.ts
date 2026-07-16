import type { NativeReplicaSession } from '../replica/native-session';
import { authHeader } from '../gateway';
import { generateDeviceDerivatives } from './derivatives-native';
import { replaySettledUploadFollowups } from './followup';
import { UploadForegroundService } from './foreground-service';
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
  const derivatives =
    input.kind === 'audio'
      ? undefined
      : await generateDeviceDerivatives(input.localUri, input.mediaType);
  const queue = UploadQueue.open({
    gatewayBaseUrl: gatewayBase,
    headers: authHeader,
    policy: nativeUploadPolicy(),
    onProgress: ({ completed, total }) => UploadForegroundService.update(completed, total),
  });
  try {
    const item = await queue.enqueue(
      {
        localUri: input.localUri,
        mediaType: input.mediaType,
        ...(input.filename ? { filename: input.filename } : {}),
        plaintextSize: input.plaintextSize,
      },
      (addressed) => ({
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
          ...(derivatives ? { phash: derivatives.phash, thumbhash: derivatives.thumbhash } : {}),
        },
        ...(derivatives ? { derivatives: derivatives.binary } : {}),
      }),
    );
    UploadForegroundService.start(queue.pending().length);
    const summary = await queue.drain();
    if (summary.settled + summary.deduped > 0)
      Store.set(LAST_SUCCESSFUL_SYNC_KEY, new Date().toISOString());
    await replaySettledUploadFollowups(queue, session, gatewayBase);
    return item.sha256;
  } finally {
    queue.close();
    UploadForegroundService.stop();
  }
}

/** Docs producer: same sha queue and transfer path, different canonical intent. */
export async function backupDocument(
  session: NativeReplicaSession,
  gatewayBase: string,
  input: {
    localUri: string;
    title: string;
    mediaType: string;
    plaintextSize: number;
    folderId?: string;
  },
): Promise<string> {
  const queue = UploadQueue.open({
    gatewayBaseUrl: gatewayBase,
    headers: authHeader,
    policy: nativeUploadPolicy(),
  });
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
    UploadForegroundService.start(queue.pending().length);
    const summary = await queue.drain();
    if (summary.settled + summary.deduped > 0)
      Store.set(LAST_SUCCESSFUL_SYNC_KEY, new Date().toISOString());
    await replaySettledUploadFollowups(queue, session, gatewayBase);
    return item.sha256;
  } finally {
    queue.close();
    UploadForegroundService.stop();
  }
}
