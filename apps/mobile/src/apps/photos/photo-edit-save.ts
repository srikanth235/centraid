// The commit behind `Save as a new photograph` (v4 handoff §7.4).
//
// THE ONLY PLACE IN THE EDITOR THAT WRITES ANYTHING. Everything the member does
// while the editor is open — rotating, straightening, choosing a ratio,
// dragging the box — is arithmetic in `photo-edit-model.ts` and pixels on the
// stage. Nothing is hashed, staged, uploaded or journalled until this function
// is called, which is what the editor's status line promises with `nothing
// written yet`. Keeping the write in a module of its own is how that promise
// stays checkable rather than remembered.
//
// The write itself is the SAME path a camera-roll photograph takes into the
// vault: `backupDeviceMedia` addresses the bytes, enqueues them on the native
// upload queue, and attaches the canonical `photos / upload` intent as the
// follow-up that lands once the bytes settle in the CAS. A new photograph made
// on the phone therefore gets the same durability, the same resume-after-
// offline behaviour and the same derivatives as one that came off the camera —
// there is no second, weaker ingest for edits.

import { File, Paths } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

import { authHeader } from "../../lib/gateway";
import type { MobileReplicaSession } from "../../lib/replica/native-session";
import { backupDeviceMedia } from "../../lib/upload/media-producer";
import { openDeviceOriginal } from "./device-media";
import { cropPixels, editedFilename, totalRotation } from "./photo-edit-model";
import type { CropRect } from "./photo-edit-model";
import type { PhotoAsset } from "./timeline-model";

/** What the member built on the stage, in frame fractions and degrees. */
export interface EditPlan {
  quarters: number;
  straighten: number;
  crop: CropRect;
}

/**
 * The full-quality bytes for `asset`, as a file this device can read.
 *
 * An original can be three things: a file we already hold, an http(s) object on
 * the gateway, or a media-store id (`ph://` on iOS, `content://` on Android)
 * which is NOT a readable file. Editing and exporting both need the same
 * answer, so they ask the same function — an edit that silently rendered from
 * the display copy would write a downscaled "new photograph" without saying so.
 */
export async function resolveLocalOriginal(asset: PhotoAsset): Promise<string> {
  const uri = asset.originalUri;
  if (uri.startsWith("http:") || uri.startsWith("https:")) {
    const name =
      asset.filename ??
      `${asset.contentId ?? asset.id}.${asset.kind === "video" ? "mp4" : "jpg"}`;
    const downloaded = await File.downloadFileAsync(
      uri,
      new File(Paths.cache, name),
      { headers: authHeader(), idempotent: true }
    );
    return downloaded.uri;
  }
  if (uri.startsWith("file:")) return uri;
  return (await openDeviceOriginal(asset.localId ?? uri)).uri;
}

/**
 * Render the edit to a file. Rotation first, then crop — the crop rectangle is
 * expressed in fractions of the ROTATED frame (that is what the member drew it
 * on), so applying it before the rotation would cut a different rectangle.
 */
async function renderEdit(
  sourceUri: string,
  plan: EditPlan
): Promise<{ uri: string; width: number; height: number }> {
  const rotation = totalRotation(plan.quarters, plan.straighten);
  const context = ImageManipulator.manipulate(sourceUri);
  if (rotation !== 0) context.rotate(rotation);
  const rotated = await context.renderAsync();
  const cropped =
    plan.crop.w >= 1 && plan.crop.h >= 1
      ? rotated
      : await ImageManipulator.manipulate(rotated)
          .crop(cropPixels(plan.crop, rotated))
          .renderAsync();
  // 0.92 JPEG: the same quality the web editor commits at, so the two surfaces
  // do not produce visibly different photographs from the same edit.
  const saved = await cropped.saveAsync({
    compress: 0.92,
    format: SaveFormat.JPEG,
  });
  return { height: saved.height, uri: saved.uri, width: saved.width };
}

export interface SaveEditDeps {
  session: MobileReplicaSession;
  gatewayBase: string;
}

/**
 * Render, then enqueue — as a NEW photograph, dated today, in the ORIGINAL's
 * vault. Never the currently selected vault or a default: a photograph that
 * lands beside its source has to land where its source is, or "beside" is a
 * lie and the edit has quietly changed who can see it (#599).
 *
 * The commit's sentence also promises "with this one recorded as its source".
 * There is NO FIELD for that: the `photos / upload` action's schema carries no
 * lineage column and refuses unknown properties, so passing `source_asset_id`
 * would be rejected rather than silently dropped. The web editor hit the same
 * wall and left the copy intact; this does too, and the gap is reported rather
 * than papered over by weakening the promise.
 */
export async function saveEditAsNewPhotograph(
  deps: SaveEditDeps,
  asset: PhotoAsset,
  plan: EditPlan
): Promise<void> {
  const sourceUri = await resolveLocalOriginal(asset);
  const rendered = await renderEdit(sourceUri, plan);
  const file = new File(rendered.uri);
  await backupDeviceMedia(deps.session, deps.gatewayBase, {
    capturedAt: new Date().toISOString(),
    filename: editedFilename(asset.filename),
    height: rendered.height,
    kind: "photo",
    localUri: rendered.uri,
    mediaType: "image/jpeg",
    plaintextSize: file.size ?? 0,
    width: rendered.width,
    // The render is a temporary file this app made; once its bytes are durable
    // there is nothing to keep. A camera-roll original is never deleted — this
    // is not one.
    deleteSourceAfterSettle: true,
    ...(asset.sourceVaultId ? { targetVaultId: asset.sourceVaultId } : {}),
  });
}
