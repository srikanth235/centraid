import * as MediaLibrary from "expo-media-library";
import { Platform } from "react-native";

import { IN_CLOUD_MESSAGE } from "./photos-backup-copy";

export { IN_CLOUD_MESSAGE } from "./photos-backup-copy";

export class InCloudOriginalError extends Error {
  readonly localId: string;
  readonly reason: unknown;

  constructor(localId: string, reason: unknown) {
    super(`This original is ${IN_CLOUD_MESSAGE}.`);
    this.name = "InCloudOriginalError";
    this.localId = localId;
    this.reason = reason;
  }
}

export interface DeviceOriginal {
  asset: MediaLibrary.Asset;
  uri: string;
}

export async function openDeviceOriginal(
  localId: string
): Promise<DeviceOriginal> {
  const asset = new MediaLibrary.Asset(localId);
  const inCloud = await isInCloud(asset);
  try {
    return { asset, uri: await asset.getUri() };
  } catch (error) {
    if (inCloud) throw new InCloudOriginalError(localId, error);
    throw error;
  }
}

export async function liveVideoUri(
  asset: MediaLibrary.Asset
): Promise<string | null> {
  return Platform.OS === "ios" ? await asset.getLivePhotoVideoUri() : null;
}

export function capturedAtIso(
  metadata: Pick<
    MediaLibrary.AssetMetadata,
    "creationTime" | "modificationTime"
  >
): string | undefined {
  const recorded = metadata.creationTime || metadata.modificationTime;
  return recorded ? new Date(recorded).toISOString() : undefined;
}

export function durationSeconds(durationMs: number | null): number | undefined {
  return durationMs === null ? undefined : durationMs / 1_000;
}

async function isInCloud(asset: MediaLibrary.Asset): Promise<boolean> {
  return Platform.OS === "ios" ? await asset.getIsInCloud() : false;
}
