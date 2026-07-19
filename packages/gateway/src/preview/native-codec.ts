import sharp from 'sharp';
import type { PreviewCodec, PreviewOutput } from '@centraid/vault';
import { rgbaToThumbHash } from './thumbhash.js';

const MAX_INPUT_PIXELS = 40_000_000;
const MAX_INPUT_EDGE = 12_000;
const THUMBHASH_EDGE = 100;

function supported(mediaType: string): boolean {
  return mediaType === 'image/jpeg' || mediaType === 'image/png';
}

function input(source: Buffer) {
  return sharp(source, { limitInputPixels: MAX_INPUT_PIXELS, sequentialRead: true }).rotate();
}

async function dimensionsAllowed(source: Buffer): Promise<boolean> {
  const metadata = await input(source).metadata();
  return (
    typeof metadata.width === 'number' &&
    typeof metadata.height === 'number' &&
    metadata.width <= MAX_INPUT_EDGE &&
    metadata.height <= MAX_INPUT_EDGE &&
    metadata.width * metadata.height <= MAX_INPUT_PIXELS
  );
}

/** Native libvips codec: decode, resize and encode all run off the JS thread. */
export function createNativeImagePreviewCodec(): PreviewCodec {
  return {
    async downscale(
      source: Buffer,
      mediaType: string,
      maxEdge: number,
    ): Promise<PreviewOutput | null> {
      if (!supported(mediaType)) return null;
      try {
        if (!(await dimensionsAllowed(source))) return null;
        const { data, info } = await input(source)
          .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 80, mozjpeg: true })
          .toBuffer({ resolveWithObject: true });
        return {
          bytes: data,
          mediaType: 'image/jpeg',
          width: info.width,
          height: info.height,
        };
      } catch {
        return null;
      }
    },

    async perceptualHash(source: Buffer, mediaType: string): Promise<string | null> {
      if (!supported(mediaType)) return null;
      try {
        if (!(await dimensionsAllowed(source))) return null;
        const pixels = await input(source)
          .greyscale()
          .resize(9, 8, { fit: 'fill' })
          .raw()
          .toBuffer();
        let hash = 0n;
        for (let y = 0; y < 8; y += 1) {
          for (let x = 0; x < 8; x += 1) {
            hash = (hash << 1n) | (pixels[y * 9 + x]! > pixels[y * 9 + x + 1]! ? 1n : 0n);
          }
        }
        return hash.toString(16).padStart(16, '0');
      } catch {
        return null;
      }
    },

    async thumbhash(source: Buffer, mediaType: string): Promise<string | null> {
      if (!supported(mediaType)) return null;
      try {
        if (!(await dimensionsAllowed(source))) return null;
        const { data, info } = await input(source)
          .resize({
            width: THUMBHASH_EDGE,
            height: THUMBHASH_EDGE,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        const bytes = rgbaToThumbHash(info.width, info.height, new Uint8Array(data));
        return Buffer.from(bytes).toString('base64').replace(/=+$/, '');
      } catch {
        return null;
      }
    },
  };
}
