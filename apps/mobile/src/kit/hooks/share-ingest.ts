// Share-target ingest core, kept free of React and native modules so the
// vitest rig can drive it with fake producers and a fake share intent (the M0
// injection lesson). The hook in `ShareIntentIngest.tsx` is a thin wrapper that
// wires the real producers, `expo-file-system`, `Alert`, and reset in.

import type { DeviceMediaInput } from '../../lib/upload/media-producer';
import type { NativeReplicaSession } from '../../lib/replica/native-session';

/** A shared file as expo-share-intent hands it to us (structural subset). */
export interface SharedIntentFileLike {
  path: string;
  mimeType: string;
  fileName?: string;
  size?: number | null;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
}

/** The shape we read off `useShareIntentContext().shareIntent`. */
export interface SharedIntentLike {
  files?: SharedIntentFileLike[] | null;
  text?: string | null;
  webUrl?: string | null;
}

// The producer input carries the #431 F10 flag: share-container copies are
// ephemeral app-group files, so they must be deleted once the upload settles.
// The flag is optional on the producer input the upload-queue agent owns; until
// that lands it is simply ignored, so passing it now is forward-compatible.
type MediaProducerInput = DeviceMediaInput & { deleteSourceAfterSettle?: boolean };
interface DocumentProducerInput {
  localUri: string;
  title: string;
  mediaType: string;
  plaintextSize: number;
  folderId?: string;
  deleteSourceAfterSettle?: boolean;
}

export interface ShareIngestPorts {
  backupDeviceMedia: (
    session: NativeReplicaSession,
    gatewayBase: string,
    input: MediaProducerInput,
  ) => Promise<unknown>;
  backupDocument: (
    session: NativeReplicaSession,
    gatewayBase: string,
    input: DocumentProducerInput,
  ) => Promise<unknown>;
  /** Plaintext size when the share intent did not carry one. */
  fileSize: (path: string) => number;
  /** Clear the latched share intent so it cannot re-fire. */
  reset: () => void;
  alert: (title: string, message: string) => void;
}

function mediaKind(mimeType: string): DeviceMediaInput['kind'] {
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'photo';
}

function isDeviceMedia(mimeType: string): boolean {
  // Audio is a first-class media kind end-to-end (media.add_asset accepts
  // 'audio', backupDeviceMedia skips derivatives for it), so shared audio goes
  // through the media producer rather than the docs shape (#431 F14e).
  return (
    mimeType.startsWith('image/') || mimeType.startsWith('video/') || mimeType.startsWith('audio/')
  );
}

/**
 * Route each shared file to its producer, then ALWAYS reset the share intent.
 * A text/URL/empty share has no v0 backing contract, so it draws an honest
 * alert instead of silently latching (#431 F9). The durable queue owns anything
 * that was enqueued, so resetting on error only prevents an infinite re-fire.
 */
export async function processShareIntent(
  ports: ShareIngestPorts,
  session: NativeReplicaSession,
  gatewayBase: string,
  shareIntent: SharedIntentLike,
): Promise<void> {
  try {
    const files = shareIntent.files ?? [];
    if (files.length === 0) {
      ports.alert(
        'Can’t save this to Centraid',
        'Centraid backs up photos, videos, audio, and documents. Links and plain text aren’t supported yet.',
      );
      return;
    }
    for (const file of files) {
      const plaintextSize = file.size ?? ports.fileSize(file.path);
      if (isDeviceMedia(file.mimeType)) {
        await ports.backupDeviceMedia(session, gatewayBase, {
          localUri: file.path,
          ...(file.fileName ? { filename: file.fileName } : {}),
          mediaType: file.mimeType,
          plaintextSize,
          kind: mediaKind(file.mimeType),
          ...(file.width != null ? { width: file.width } : {}),
          ...(file.height != null ? { height: file.height } : {}),
          ...(file.duration != null ? { durationS: file.duration } : {}),
          deleteSourceAfterSettle: true,
        });
      } else {
        await ports.backupDocument(session, gatewayBase, {
          localUri: file.path,
          title: file.fileName ?? file.path,
          mediaType: file.mimeType,
          plaintextSize,
          deleteSourceAfterSettle: true,
        });
      }
    }
  } catch (error) {
    ports.alert('Save to Centraid paused', error instanceof Error ? error.message : String(error));
  } finally {
    ports.reset();
  }
}

/**
 * Re-entrancy guard: a re-render (or a second intent) while an ingest is still
 * in flight must not start a second pass over the same files (#431 F9 test).
 * The hook holds one gate across renders via a ref.
 */
export class ShareIntentGate {
  private running = false;
  async run(task: () => Promise<void>): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await task();
    } finally {
      this.running = false;
    }
  }
}
