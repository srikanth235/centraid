import * as MediaLibrary from "expo-media-library";

import {
  SHARE_PLACE_NOT_REMOVABLE,
  sharePlaceReceipt,
} from "@centraid/blueprints/apps/photos/share-place";
import type {
  SharePlaceInput,
  SharePlacePrecision,
} from "@centraid/blueprints/apps/photos/share-place";
import {
  PHOTOS_ERROR_EXPORT_FAILED,
  PHOTOS_ERROR_IN_CLOUD,
} from "@centraid/blueprints/apps/photos/shared-copy";
import { RETRY_ACTION } from "@centraid/client/surface-copy";

import { postStatus } from "../../kit/components/status-line";
import { InCloudOriginalError } from "./device-media";
import { resolveLocalOriginal } from "./photo-edit-save";
import { LocationNotRemovableError, shareOriginal } from "./photo-share";
import type { PhotoAsset } from "./timeline-model";

// Same original bytes the editor resolves.
export async function saveToCameraRoll(asset: PhotoAsset): Promise<void> {
  await MediaLibrary.Asset.create(await resolveLocalOriginal(asset));
}

// Post the receipt EVERY time; silence reads as safety.
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

// Unremovable location refuses the share, loudly.
export function surfaceExportFailure(error: unknown): void {
  // `LocationNotRemovableError` carries AUTHORED copy — a loud, specific
  // refusal the member can act on — so it speaks for itself. Everything else
  // gets the noun and the retry word; the engine's sentence goes to the log.
  if (error instanceof LocationNotRemovableError) {
    postStatus(SHARE_PLACE_NOT_REMOVABLE);
    return;
  }
  console.warn("[photos] export failed", error);
  postStatus(
    `${error instanceof InCloudOriginalError ? PHOTOS_ERROR_IN_CLOUD : PHOTOS_ERROR_EXPORT_FAILED} ${RETRY_ACTION}`
  );
}
