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

export const SHARE_UNPAIRED_TITLE = "Can’t receive shares yet";
export const SHARE_UNPAIRED_MESSAGE =
  "Pair this phone with your Centraid desktop, then share again.";

export const SHARE_STAGING_STALE_MS = 24 * 60 * 60 * 1000;

export const SHARE_STAGING_SWEEP_LIMIT = 200;

export interface ShareStagingEntry {
  uri: string;
  isFile: boolean;
  lastModifiedMs?: number;
}

export interface ShareStagingPorts {
  stagedEntries: () => readonly ShareStagingEntry[] | undefined;
  deleteStaged: (uri: string) => void;
  now: () => number;
}

export interface ShareTargetScope {
  vaultId: string;
  label: string;
  canWrite: boolean;
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
  return (
    mimeType.startsWith("image/") ||
    mimeType.startsWith("video/") ||
    mimeType.startsWith("audio/")
  );
}

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

export function discardShareIntentFiles(
  deleteStaged: (path: string) => void,
  shareIntent: SharedIntentLike
): void {
  for (const file of shareIntent.files ?? []) deleteStaged(file.path);
}

export function sweepStaleShareStaging(ports: ShareStagingPorts): number {
  const entries = ports.stagedEntries();
  if (!entries) return 0;
  const cutoff = ports.now() - SHARE_STAGING_STALE_MS;
  let swept = 0;
  for (const entry of entries) {
    if (swept >= SHARE_STAGING_SWEEP_LIMIT) break;
    if (!entry.isFile) continue;
    if (entry.lastModifiedMs === undefined || entry.lastModifiedMs > cutoff)
      continue;
    ports.deleteStaged(entry.uri);
    swept += 1;
  }
  return swept;
}

export function shareTargetChoices(
  scopes: readonly ShareTargetScope[]
): readonly ShareTargetScope[] {
  const writable = scopes.filter((scope) => scope.canWrite);
  return writable.length > 1 ? writable : [];
}

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
