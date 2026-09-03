import * as MediaLibrary from "expo-media-library";

import { sharePlaceReceipt } from "@centraid/blueprints/apps/photos/share-place";
import type {
  SharePlaceInput,
  SharePlacePrecision,
} from "@centraid/blueprints/apps/photos/share-place";

import { postStatus } from "../../kit/components/status-line";
import { InCloudOriginalError } from "./device-media";
import { resolveLocalOriginal } from "./photo-edit-save";
import { LocationNotRemovableError, shareOriginal } from "./photo-share";
import type { PhotoAsset } from "./timeline-model";

export async function saveToCameraRoll(asset: PhotoAsset): Promise<void> {
  await MediaLibrary.Asset.create(await resolveLocalOriginal(asset));
}

export async function sendCopy(
  asset: PhotoAsset,
  precision: SharePlacePrecision,
  place: SharePlaceInput
): Promise<void> {
  await shareOriginal({
    filename: asset.filename,
    kind: asset.kind,
    place,
    precision,
    uri: await resolveLocalOriginal(asset),
  });
  postStatus(sharePlaceReceipt(precision, place));
}

export function surfaceExportFailure(error: unknown): void {
  postStatus(
    error instanceof LocationNotRemovableError
      ? error.message
      : `${error instanceof InCloudOriginalError ? "Original is in iCloud" : "Export failed"}: ${error instanceof Error ? error.message : String(error)}`
  );
}
