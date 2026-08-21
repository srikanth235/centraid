// THE TWO VERBS THAT TAKE A PHOTOGRAPH OUT OF THE VIEWER, and the one
// sentence that says when either could not (#712 Download / Send a copy,
// #816 place precision).
//
// They look like a pair and are not. `saveToCameraRoll` writes to the
// member's OWN device library, beside the original it came from, so there is
// nothing to disclose and nothing to ask. `sendCopy` hands bytes to somebody
// else, so it goes through `photo-share.ts`, which asks first and strips the
// file after.
//
// Lifted out of `PhotoLightbox.tsx` when the precision choice landed: the
// viewer coordinates a gesture and chrome state machine, and "what leaves this
// device, carrying what" is a different subject that deserves its own header
// and its own tests.

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

/**
 * Download — a copy in this device's own camera roll.
 *
 * `resolveLocalOriginal` is the same resolution the editor uses (download an
 * http original, resolve a media-store id to real bytes): saving and editing
 * must not disagree about which bytes ARE the original.
 */
export async function saveToCameraRoll(asset: PhotoAsset): Promise<void> {
  await MediaLibrary.Asset.create(await resolveLocalOriginal(asset));
}

/**
 * Send a copy at the precision the member chose — and say what left.
 *
 * The receipt is posted every time, including when nothing about the place
 * went with it: a member who only ever hears about a disclosure learns to read
 * silence as safety, which is exactly the habit this feature must not build.
 */
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

/**
 * Neither verb fails quietly.
 *
 * An iCloud-only original says so. A location that could not be taken out of
 * the bytes says so in its own words — and the share was refused rather than
 * sent with the fix still in it, which is the part the sentence has to make
 * clear.
 */
export function surfaceExportFailure(error: unknown): void {
  postStatus(
    error instanceof LocationNotRemovableError
      ? error.message
      : `${error instanceof InCloudOriginalError ? "Original is in iCloud" : "Export failed"}: ${error instanceof Error ? error.message : String(error)}`
  );
}
