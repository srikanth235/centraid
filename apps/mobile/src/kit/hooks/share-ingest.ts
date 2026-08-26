// React-free share-ingest core; `ShareIntentIngest.tsx` wires real producers.

import type { MobileReplicaSession } from "../../lib/replica/native-session";
import type { DeviceMediaInput } from "../../lib/upload/media-producer";

export interface SharedIntentFileLike {
  path: string;
  mimeType: string;
  fileName?: string;
  size?: number | null;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
}

export interface SharedIntentLike {
  files?: SharedIntentFileLike[] | null;
  text?: string | null;
  webUrl?: string | null;
}

// #431: optional until the upload-queue agent's input carries the flag.
type MediaProducerInput = DeviceMediaInput & {
  deleteSourceAfterSettle?: boolean;
};
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
    session: MobileReplicaSession,
    gatewayBase: string,
    input: MediaProducerInput
  ) => Promise<unknown>;
  backupDocument: (
    session: MobileReplicaSession,
    gatewayBase: string,
    input: DocumentProducerInput
  ) => Promise<unknown>;
  fileSize: (path: string) => number;
  reset: () => void;
  alert: (title: string, message: string) => void;
}

function mediaKind(mimeType: string): DeviceMediaInput["kind"] {
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "photo";
}

function isDeviceMedia(mimeType: string): boolean {
  // #431: shared audio goes through the media producer.
  return (
    mimeType.startsWith("image/") ||
    mimeType.startsWith("video/") ||
    mimeType.startsWith("audio/")
  );
}

/**
 * Route each confirmed file to its producer, then ALWAYS reset — the durable
 * queue owns anything enqueued, so resetting on error only prevents re-fire.
 */
export async function processShareIntent(
  ports: ShareIngestPorts,
  session: MobileReplicaSession,
  gatewayBase: string,
  shareIntent: SharedIntentLike,
  targetVaultId?: string
): Promise<void> {
  try {
    const files = shareIntent.files ?? [];
    if (files.length === 0) {
      ports.alert(
        "Can’t save this to Centraid",
        "Only photos, videos, audio and documents — text and links use Quick capture."
      );
      return;
    }
    const processFile = async (index: number): Promise<void> => {
      const file = files[index];
      if (!file) return;
      const plaintextSize = file.size ?? ports.fileSize(file.path);
      if (isDeviceMedia(file.mimeType)) {
        await ports.backupDeviceMedia(session, gatewayBase, {
          localUri: file.path,
          ...(targetVaultId ? { targetVaultId } : {}),
          ...(file.fileName ? { filename: file.fileName } : {}),
          mediaType: file.mimeType,
          plaintextSize,
          kind: mediaKind(file.mimeType),
          ...(file.width == null ? {} : { width: file.width }),
          ...(file.height == null ? {} : { height: file.height }),
          ...(file.duration == null ? {} : { durationS: file.duration }),
          deleteSourceAfterSettle: true,
        });
      } else {
        await ports.backupDocument(session, gatewayBase, {
          localUri: file.path,
          ...(targetVaultId ? { targetVaultId } : {}),
          title: file.fileName ?? file.path,
          mediaType: file.mimeType,
          plaintextSize,
          deleteSourceAfterSettle: true,
        });
      }
      return processFile(index + 1);
    };
    await processFile(0);
  } catch (error) {
    ports.alert(
      "Save to Centraid paused",
      error instanceof Error ? error.message : String(error)
    );
  } finally {
    ports.reset();
  }
}

/** Re-entrancy guard (#431 test): no second pass while ingest is in flight. */
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
