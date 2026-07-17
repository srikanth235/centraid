import { Directory, File, Paths } from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import * as VideoThumbnails from 'expo-video-thumbnails';
import jpeg from 'jpeg-js';
import { rgbaToThumbHash } from 'thumbhash';

import { authHeader } from '../gateway';
import { bytesToBase64 } from './bytes';

export type DeviceDerivativeVariant = 'thumb' | 'preview' | 'poster';

export interface DeviceDerivative {
  variant: DeviceDerivativeVariant;
  uri: string;
  mediaType: 'image/jpeg';
}

export interface DeviceDerivativeSet {
  binary: DeviceDerivative[];
  thumbhash: string;
  phash: string;
}

/**
 * ImageManipulator writes rungs into the OS-trimmable cache. Their URIs are
 * persisted in the follow-up ledger and read back on replay — possibly days
 * later — so a cache trim between generation and contribution would throw
 * forever and starve the record (F3). Copy each rung into a durable directory
 * under the document root instead, and delete it once the follow-up settles.
 */
const DERIVATIVES_DIRNAME = 'centraid-upload-derivatives';

function durableDerivativesDir(): Directory {
  const dir = new Directory(Paths.document, DERIVATIVES_DIRNAME);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

/** Copy a cache rung to durable storage and return its stable URI. */
function persistDurably(cacheUri: string, name: string): string {
  const destination = new File(durableDerivativesDir(), name);
  if (destination.exists) destination.delete();
  new File(cacheUri).copy(destination);
  return destination.uri;
}

async function jpegRung(uri: string, width: number, compress: number): Promise<string> {
  const result = await ImageManipulator.manipulateAsync(uri, [{ resize: { width } }], {
    compress,
    format: ImageManipulator.SaveFormat.JPEG,
  });
  return result.uri;
}

/**
 * 8×8 difference hash of a decoded thumbnail. Exported for unit coverage: pure
 * arithmetic over RGBA, no native dependency.
 */
export function dhash(width: number, height: number, data: Uint8Array): string {
  let bits = 0n;
  for (let y = 0; y < 8; y += 1) {
    const sy = Math.min(height - 1, Math.floor(((y + 0.5) * height) / 8));
    for (let x = 0; x < 8; x += 1) {
      const leftX = Math.min(width - 1, Math.floor((x * width) / 9));
      const rightX = Math.min(width - 1, Math.floor(((x + 1) * width) / 9));
      const left = (sy * width + leftX) * 4;
      const right = (sy * width + rightX) * 4;
      const a = data[left]! * 299 + data[left + 1]! * 587 + data[left + 2]! * 114;
      const b = data[right]! * 299 + data[right + 1]! * 587 + data[right + 2]! * 114;
      bits = (bits << 1n) | (a > b ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, '0');
}

/** HEIC/video-safe device derivatives: native decode first, tiny JPEG decode second. */
export async function generateDeviceDerivatives(
  localUri: string,
  mediaType: string,
): Promise<DeviceDerivativeSet> {
  const source = mediaType.startsWith('video/')
    ? (await VideoThumbnails.getThumbnailAsync(localUri, { time: 0, quality: 0.9 })).uri
    : localUri;
  const thumb = await jpegRung(source, 256, 0.82);
  const preview = await jpegRung(source, 2_048, 0.86);
  const poster = mediaType.startsWith('video/') ? await jpegRung(source, 1_024, 0.86) : undefined;
  const decoded = jpeg.decode(await new File(thumb).bytes(), { useTArray: true });
  const thumbhash = bytesToBase64(
    rgbaToThumbHash(decoded.width, decoded.height, decoded.data),
  ).replace(/=+$/, '');
  // A per-set token keeps concurrent producers from colliding on durable names.
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    binary: [
      {
        variant: 'thumb',
        uri: persistDurably(thumb, `${token}-thumb.jpg`),
        mediaType: 'image/jpeg',
      },
      {
        variant: 'preview',
        uri: persistDurably(preview, `${token}-preview.jpg`),
        mediaType: 'image/jpeg',
      },
      ...(poster
        ? [
            {
              variant: 'poster' as const,
              uri: persistDurably(poster, `${token}-poster.jpg`),
              mediaType: 'image/jpeg' as const,
            },
          ]
        : []),
    ],
    thumbhash,
    phash: dhash(decoded.width, decoded.height, decoded.data),
  };
}

export async function contributeDeviceDerivatives(
  gatewayBase: string,
  parentSha: string,
  derivatives: readonly DeviceDerivative[],
): Promise<void> {
  for (const derivative of derivatives) {
    const file = new File(derivative.uri);
    // Derivatives are gateway-regenerable accelerators, not correctness. If the
    // durable copy is somehow gone, skip it rather than throw — a thrown error
    // would poison the whole follow-up, including its canonical replica write.
    if (!file.exists) continue;
    const params = new URLSearchParams({
      variant: derivative.variant,
      variant_of: parentSha,
      media_type: derivative.mediaType,
    });
    const response = await fetch(`${gatewayBase}/centraid/_vault/blobs?${params}`, {
      method: 'POST',
      headers: { 'content-type': derivative.mediaType, ...authHeader() },
      body: (await file.bytes()).buffer as ArrayBuffer,
    });
    if (!response.ok)
      throw new Error(`Derivative ${derivative.variant} failed (${response.status})`);
  }
}

/** Delete durable derivative copies once their follow-up has settled (F3/F10). */
export function cleanupDeviceDerivatives(derivatives: readonly DeviceDerivative[]): void {
  for (const derivative of derivatives) {
    try {
      const file = new File(derivative.uri);
      if (file.exists) file.delete();
    } catch {
      // A leaked temp is a cosmetic loss, never a correctness one.
    }
  }
}
