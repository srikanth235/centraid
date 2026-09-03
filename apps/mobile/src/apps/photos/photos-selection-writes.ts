import { runSelectionBatch } from "@centraid/blueprints/apps/_shared/selection-engine";

import { ensureOfflineContent } from "../../kit/fetch-gate/download";
import type {
  MobileReplicaSession,
  NativeWriteResult,
} from "../../lib/replica/native-session";
import type { PhotoAsset } from "./timeline-model";

export type VaultAsset = PhotoAsset & { assetId: string };

export function vaultAssets(
  assets: readonly PhotoAsset[],
  selection: ReadonlySet<string>
): VaultAsset[] {
  return assets.filter(
    (asset): asset is VaultAsset =>
      selection.has(asset.id) && Boolean(asset.assetId)
  );
}

type Emit = (result: NativeWriteResult) => void;

async function runSerially(
  targets: readonly VaultAsset[],
  write: (asset: VaultAsset) => Promise<NativeWriteResult>,
  emit: Emit
): Promise<void> {
  const results = await runSelectionBatch(targets, write);
  const failures: unknown[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") emit(result.value);
    else failures.push(result.reason);
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} selection write${failures.length === 1 ? "" : "s"} failed`
    );
  }
}

export function batchFavorite(
  session: MobileReplicaSession,
  targets: readonly VaultAsset[],
  emit: Emit,
  on = true
): Promise<void> {
  return runSerially(
    targets,
    (asset) =>
      session.write("photos", {
        action: "update-asset",
        input: { asset_id: asset.assetId, favorite: on ? 1 : 0 },
      }),
    emit
  );
}

export function batchTrash(
  session: MobileReplicaSession,
  targets: readonly VaultAsset[],
  emit: Emit
): Promise<void> {
  return runSerially(
    targets,
    (asset) =>
      session.write("photos", {
        action: "delete-asset",
        input: { asset_id: asset.assetId },
      }),
    emit
  );
}

export function batchRestore(
  session: MobileReplicaSession,
  targets: readonly VaultAsset[],
  emit: Emit
): Promise<void> {
  return runSerially(
    targets,
    (asset) =>
      session.write("photos", {
        action: "restore",
        input: { asset_id: asset.assetId },
      }),
    emit
  );
}

export function batchPurge(
  session: MobileReplicaSession,
  targets: readonly VaultAsset[],
  emit: Emit
): Promise<void> {
  return runSerially(
    targets,
    (asset) =>
      session.write("photos", {
        action: "purge-asset",
        input: { asset_id: asset.assetId },
      }),
    emit
  );
}

export function batchAddToAlbum(
  session: MobileReplicaSession,
  targets: readonly VaultAsset[],
  albumId: string,
  firstPosition: number,
  emit: Emit
): Promise<void> {
  let position = firstPosition;
  return runSerially(
    targets,
    (asset) => {
      return session.write("photos", {
        action: "add-to-album",
        input: {
          album_id: albumId,
          asset_id: asset.assetId,
          position: position++,
        },
      });
    },
    emit
  );
}

export type DownloadableAsset = VaultAsset & {
  contentId: string;
  sourceVaultId: string;
};

export function downloadableAssets(
  targets: readonly VaultAsset[]
): DownloadableAsset[] {
  return targets.filter(
    (asset): asset is DownloadableAsset =>
      Boolean(asset.contentId) &&
      Boolean(asset.sourceVaultId) &&
      Boolean(asset.originalUri)
  );
}

export interface DownloadSummary {
  stored: number;
  needsChoice: number;
  unavailable: number;
  reason?: string;
}

export interface DownloadOptions {
  headers: Record<string, string>;
  networkType?: string;
  consented?: boolean;
  online?: boolean;
}

export async function batchDownload(
  targets: readonly DownloadableAsset[],
  options: DownloadOptions
): Promise<DownloadSummary> {
  const summary: DownloadSummary = {
    stored: 0,
    needsChoice: 0,
    unavailable: 0,
  };
  for (const asset of targets) {
    // oxlint-disable-next-line no-await-in-loop -- serial IS the contract here: one store, one radio (see runSerially above)
    const outcome = await ensureOfflineContent({
      ref: { contentId: asset.contentId, scopeId: asset.sourceVaultId },
      url: asset.originalUri,
      headers: options.headers,
      pin: true,
      ...(options.networkType === undefined
        ? {}
        : { networkType: options.networkType }),
      ...(options.consented === undefined
        ? {}
        : { consented: options.consented }),
      ...(options.online === undefined ? {} : { online: options.online }),
    });
    if (outcome.status === "stored") summary.stored += 1;
    else if (outcome.status === "needs-choice") summary.needsChoice += 1;
    else {
      summary.unavailable += 1;
      summary.reason ??= outcome.reason;
    }
  }
  return summary;
}

export function downloadStatus(summary: DownloadSummary): string {
  const parts: string[] = [];
  if (summary.stored > 0)
    parts.push(
      `${summary.stored} ${summary.stored === 1 ? "original is" : "originals are"} on this phone`
    );
  if (summary.needsChoice > 0)
    parts.push(
      `${summary.needsChoice} held — this connection is metered, so tap Download again to spend the bytes`
    );
  if (summary.unavailable > 0)
    parts.push(
      `${summary.unavailable} could not be downloaded${summary.reason ? `: ${summary.reason}` : ""}`
    );
  return parts.length > 0
    ? parts.join(". ")
    : "Nothing in this selection has originals on the gateway to download.";
}

export const NOTHING_TO_DOWNLOAD_REASON =
  "These are on this device already — there is nothing on the gateway to fetch.";
