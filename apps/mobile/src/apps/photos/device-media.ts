// Camera-roll originals: resolving one to real bytes, and saying so out loud
// when the bytes are not on this device.
//
// expo-media-library Next API has no shouldDownloadFromNetwork equivalent (#573).
// The legacy call this replaces stated the caller's willingness to pull an
// iCloud-only original — `getAssetInfoAsync(id, { shouldDownloadFromNetwork:
// true })`. The Next getters take no options at all: on iOS `getUri()` requests
// the original with network access allowed, so the download is still attempted,
// but nothing in the result says whether it happened. `getIsInCloud()` is the
// only way to ask, and it has to be asked BEFORE the fetch — afterwards a
// failed asset and an undownloaded one look alike. That ordering is what turns
// "this photo did not back up" into "this photo is still in iCloud", which is
// the sentence the user can act on.

import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';

/** One phrasing, shared by every flow that meets an undownloaded original. */
export const IN_CLOUD_MESSAGE = 'in iCloud — not downloaded on this device';

/**
 * Raised instead of quietly skipping an asset whose bytes never came down.
 * Callers are expected to tell the user; none of them may swallow this.
 */
export class InCloudOriginalError extends Error {
  readonly localId: string;
  /** The underlying media-library failure, kept for the alert copy and logs. */
  readonly reason: unknown;

  constructor(localId: string, reason: unknown) {
    super(`This original is ${IN_CLOUD_MESSAGE}.`);
    this.name = 'InCloudOriginalError';
    this.localId = localId;
    this.reason = reason;
  }
}

export interface DeviceOriginal {
  /** Handle for follow-up reads — the Live Photo companion, deletion, EXIF. */
  asset: MediaLibrary.Asset;
  /** A URI holding the full-quality bytes, on this device, right now. */
  uri: string;
}

/**
 * Address one camera-roll original by its media-store id and resolve it to
 * bytes this device can read, downloading from iCloud when the OS will.
 *
 * @throws {InCloudOriginalError} when the original is still only in iCloud.
 */
export async function openDeviceOriginal(localId: string): Promise<DeviceOriginal> {
  const asset = new MediaLibrary.Asset(localId);
  const inCloud = await isInCloud(asset);
  try {
    return { asset, uri: await asset.getUri() };
  } catch (reason) {
    if (inCloud) throw new InCloudOriginalError(localId, reason);
    throw reason;
  }
}

/** The extracted companion MOV of a Live Photo, or `null` when there is none. */
export async function liveVideoUri(asset: MediaLibrary.Asset): Promise<string | null> {
  // Live Photos are an iOS concept and the getter throws an UnavailabilityError
  // anywhere else, so Android answers with "no companion".
  return Platform.OS === 'ios' ? await asset.getLivePhotoVideoUri() : null;
}

/**
 * Capture instant of a media-store row. Both timestamps are nullable in the
 * Next API — the store does not always record them — and filing a photo under
 * 1970 is worse than filing it by when it was last written, so modification
 * time stands in before the epoch does.
 */
export function capturedAtIso(
  metadata: Pick<MediaLibrary.AssetMetadata, 'creationTime' | 'modificationTime'>,
): string {
  return new Date(metadata.creationTime ?? metadata.modificationTime ?? 0).toISOString();
}

/**
 * The Next API reports durations in milliseconds where the legacy API reported
 * seconds; the timeline model speaks seconds.
 */
export function durationSeconds(durationMs: number | null): number | undefined {
  return durationMs === null ? undefined : durationMs / 1_000;
}

/** iCloud Photo Library is iOS-only; `getIsInCloud()` throws anywhere else. */
async function isInCloud(asset: MediaLibrary.Asset): Promise<boolean> {
  return Platform.OS === 'ios' ? await asset.getIsInCloud() : false;
}
