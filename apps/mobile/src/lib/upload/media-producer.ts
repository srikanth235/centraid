import { File } from "expo-file-system";

import { Store } from "../../storage";
import { authHeader } from "../gateway";
import type { MobileReplicaSession } from "../replica/native-session";
import { foldPendingUploadGroups } from "../replica/storage-accounting";
import { generateDeviceDerivatives } from "./derivatives-native";
import { withDrainLock } from "./drain-lock";
import { sha256OfFile } from "./enqueue";
import { expoFileSource } from "./expo-native";
import { replaySettledUploadFollowups } from "./followup";
import { UploadForegroundService } from "./foreground-service";
import { createNativeDigest } from "./native-digest";
import { LAST_SUCCESSFUL_SYNC_KEY, nativeUploadPolicy } from "./native-policy";
import { UploadQueue } from "./native-queue";

export interface DeviceMediaInput {
  localUri: string;
  targetVaultId?: string;
  filename?: string;
  mediaType: string;
  plaintextSize: number;
  kind: "photo" | "video" | "audio" | "scan";
  capturedAt?: string;
  tzOffsetMin?: number;
  captureGroupId?: string;
  sourceAssetId?: string;
  width?: number;
  height?: number;
  durationS?: number;
  deleteSourceAfterSettle?: boolean;
  onProgress?: (progress: { completed: number; total: number }) => void;
}

export interface BackupDocumentInput {
  localUri: string;
  targetVaultId?: string;
  title: string;
  mediaType: string;
  plaintextSize: number;
  folderId?: string;
  extractedText?: string;
  deleteSourceAfterSettle?: boolean;
}

export interface ReceiptExpenseInput {
  localUri: string;
  targetVaultId?: string;
  filename: string;
  mediaType: string;
  plaintextSize: number;
  deleteSourceAfterSettle?: boolean;
  group_id: string;
  description: string;
  amount_minor: number;
  paid_by: string;
  spent_on: string;
  category: string;
  ocr_text: string;
  splits: Array<{ party_id: string; share_minor: number }>;
  line_items: Array<{
    kind: "item" | "tax" | "tip";
    description: string;
    amount_minor: number;
    allocations: Array<{ party_id: string; share_minor: number }>;
  }>;
}

function openQueue(
  gatewayBase: string,
  onProgress?: DeviceMediaInput["onProgress"]
): UploadQueue {
  return UploadQueue.open({
    gatewayBaseUrl: gatewayBase,
    headers: authHeader,
    policy: nativeUploadPolicy(),
    onProgress: ({ completed, total }) => {
      UploadForegroundService.update(completed, total);
      onProgress?.({ completed, total });
    },
  });
}

async function drainToSettlement(
  session: MobileReplicaSession,
  gatewayBase: string,
  queue: UploadQueue,
  sha256: string,
  source: { localUri: string; deleteAfterSettle: boolean }
): Promise<string> {
  await withDrainLock(async () => {
    UploadForegroundService.start(
      foldPendingUploadGroups(queue.pendingStorageGroups()).total.itemCount
    );
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
  if (item?.state === "failed") {
    throw new Error(
      `backup of ${sha256} did not settle: ${item.lastError ?? "unknown error"}`
    );
  }
  if (item && queue.hasFollowupForItem(item.itemId)) {
    throw new Error(
      `backup of ${sha256} settled, but its canonical record was not accepted`
    );
  }
  if (source.deleteAfterSettle && item?.state === "settled")
    deleteSource(source.localUri);
  return sha256;
}

function deleteSource(localUri: string): void {
  try {
    const file = new File(localUri);
    if (file.exists) file.delete();
  } catch {
    // Intentionally empty.
  }
}

export async function backupDeviceMedia(
  session: MobileReplicaSession,
  gatewayBase: string,
  input: DeviceMediaInput
): Promise<string> {
  const queue = openQueue(gatewayBase, input.onProgress);
  try {
    const digest = await sha256OfFile(
      expoFileSource,
      input.localUri,
      createNativeDigest
    );
    const isNew = queue.bySha(digest.sha256) === undefined;
    const derivatives =
      isNew && input.kind !== "audio"
        ? await generateDeviceDerivatives(input.localUri, input.mediaType)
        : undefined;
    const item = await queue.enqueue(
      {
        localUri: input.localUri,
        ...(input.targetVaultId ? { targetVaultId: input.targetVaultId } : {}),
        mediaType: input.mediaType,
        ...(input.filename ? { filename: input.filename } : {}),
        plaintextSize: input.plaintextSize,
        digest,
      },
      isNew
        ? (addressed) => ({
            shape: "photos",
            action: "upload",
            input: {
              staged_sha: addressed.sha256,
              kind: input.kind,
              ...(input.capturedAt ? { captured_at: input.capturedAt } : {}),
              ...(input.tzOffsetMin === undefined
                ? {}
                : { tz_offset_min: input.tzOffsetMin }),
              ...(input.captureGroupId
                ? { capture_group_id: input.captureGroupId }
                : {}),
              ...(input.sourceAssetId
                ? { source_asset_id: input.sourceAssetId }
                : {}),
              ...(input.filename ? { title: input.filename } : {}),
              ...(input.width ? { width: input.width } : {}),
              ...(input.height ? { height: input.height } : {}),
              ...(input.durationS === undefined
                ? {}
                : { duration_s: input.durationS }),
              ...(derivatives
                ? { phash: derivatives.phash, thumbhash: derivatives.thumbhash }
                : {}),
            },
            ...(derivatives ? { derivatives: derivatives.binary } : {}),
          })
        : undefined
    );
    return await drainToSettlement(session, gatewayBase, queue, item.sha256, {
      localUri: input.localUri,
      deleteAfterSettle: input.deleteSourceAfterSettle ?? false,
    });
  } finally {
    queue.close();
  }
}

export async function backupDocument(
  session: MobileReplicaSession,
  gatewayBase: string,
  input: BackupDocumentInput
): Promise<string> {
  const queue = openQueue(gatewayBase);
  try {
    const item = await queue.enqueue(
      {
        localUri: input.localUri,
        ...(input.targetVaultId ? { targetVaultId: input.targetVaultId } : {}),
        filename: input.title,
        mediaType: input.mediaType,
        plaintextSize: input.plaintextSize,
      },
      (addressed) => ({
        shape: "docs",
        action: "upload",
        input: {
          staged_sha: addressed.sha256,
          title: input.title,
          ...(input.folderId ? { folder_id: input.folderId } : {}),
          ...(input.extractedText
            ? { extracted_text: input.extractedText }
            : {}),
        },
      })
    );
    return await drainToSettlement(session, gatewayBase, queue, item.sha256, {
      localUri: input.localUri,
      deleteAfterSettle: input.deleteSourceAfterSettle ?? false,
    });
  } finally {
    queue.close();
  }
}

export async function backupReceiptExpense(
  session: MobileReplicaSession,
  gatewayBase: string,
  input: ReceiptExpenseInput
): Promise<string> {
  const queue = openQueue(gatewayBase);
  try {
    const item = await queue.enqueue(
      {
        localUri: input.localUri,
        ...(input.targetVaultId ? { targetVaultId: input.targetVaultId } : {}),
        filename: input.filename,
        mediaType: input.mediaType,
        plaintextSize: input.plaintextSize,
      },
      (addressed) => ({
        shape: "tally",
        action: "add-receipt-expense",
        input: {
          staged_sha: addressed.sha256,
          group_id: input.group_id,
          description: input.description,
          amount_minor: input.amount_minor,
          paid_by: input.paid_by,
          spent_on: input.spent_on,
          category: input.category,
          ocr_text: input.ocr_text,
          splits: input.splits,
          line_items: input.line_items,
        },
      })
    );
    return await drainToSettlement(session, gatewayBase, queue, item.sha256, {
      localUri: input.localUri,
      deleteAfterSettle: input.deleteSourceAfterSettle ?? false,
    });
  } finally {
    queue.close();
  }
}
