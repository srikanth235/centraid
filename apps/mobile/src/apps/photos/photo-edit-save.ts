import { File, Paths } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

import { authHeader } from "../../lib/gateway";
import type { MobileReplicaSession } from "../../lib/replica/native-session";
import { backupDeviceMedia } from "../../lib/upload/media-producer";
import { openDeviceOriginal } from "./device-media";
import { cropPixels, editedFilename, totalRotation } from "./photo-edit-model";
import type { CropRect, FlipAxis } from "./photo-edit-model";
import type { PhotoAsset } from "./timeline-model";

export interface EditPlan {
  quarters: number;
  straighten: number;
  crop: CropRect;
  flip?: FlipAxis;
}

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

async function renderEdit(
  sourceUri: string,
  plan: EditPlan
): Promise<{ uri: string; width: number; height: number }> {
  const rotation = totalRotation(plan.quarters, plan.straighten);
  const context = ImageManipulator.manipulate(sourceUri);
  if (plan.flip) context.flip(plan.flip);
  if (rotation !== 0) context.rotate(rotation);
  const rotated = await context.renderAsync();
  const cropped =
    plan.crop.w >= 1 && plan.crop.h >= 1
      ? rotated
      : await ImageManipulator.manipulate(rotated)
          .crop(cropPixels(plan.crop, rotated))
          .renderAsync();
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
    deleteSourceAfterSettle: true,
    ...(asset.sourceVaultId ? { targetVaultId: asset.sourceVaultId } : {}),
    ...(asset.assetId ? { sourceAssetId: asset.assetId } : {}),
  });
}
