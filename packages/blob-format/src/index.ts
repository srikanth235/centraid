export const CBSF_MAGIC = 'CBSF';
export const CBSF_VERSION = 2;
export const CBSF_HEADER_BYTES = 37;
export const CBSF_TRAILER_BYTES = 13;
export const CBSF_NONCE_BYTES = 12;
/** Canonical preview-ladder edges shared by gateway and browser capture. */
export const BLOB_TINY_EDGE = 256;
export const BLOB_MEDIUM_EDGE = 2_048;

export function cbsfFrameAad(sha: string, index: number, frameCount: number): string {
  return `blob:${sha}:v${CBSF_VERSION}:f${index}/${frameCount}`;
}

export function cbsfDirectoryAad(sha: string, frameCount: number): string {
  return `blobdir:${sha}:v${CBSF_VERSION}:n${frameCount}`;
}

export function decodeCbsfDirectory(
  bytes: Uint8Array,
  frameCount: number,
): { frameSize: number; totalSize: number; sealedLens: number[] } {
  if (bytes.byteLength !== 16 + frameCount * 4) throw new Error('CBSF directory size mismatch');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frameSize = view.getUint32(0, false);
  const totalSize = Number(view.getBigUint64(4, false));
  const encodedCount = view.getUint32(12, false);
  if (!Number.isSafeInteger(totalSize) || encodedCount !== frameCount)
    throw new Error('CBSF directory metadata mismatch');
  return {
    frameSize,
    totalSize,
    sealedLens: Array.from({ length: frameCount }, (_, index) =>
      view.getUint32(16 + index * 4, false),
    ),
  };
}

export function encodeCbsfDirectory(
  frameSize: number,
  totalSize: number,
  sealedLens: readonly number[],
): Uint8Array {
  const bytes = new Uint8Array(16 + sealedLens.length * 4);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, frameSize, false);
  view.setBigUint64(4, BigInt(totalSize), false);
  view.setUint32(12, sealedLens.length, false);
  for (const [index, length] of sealedLens.entries()) view.setUint32(16 + index * 4, length, false);
  return bytes;
}
