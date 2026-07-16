// Paired-device direct CAS reader (issue #414 D11/D12). The gateway mints a
// short-lived provider URL + raw per-blob key; ciphertext then travels provider
// → device, never through the Pi. CBSF frames are fetched and opened one at a
// time, so JS retains at most one sealed frame beyond the final browser Blob.

const HEADER_BYTES = 37;
const TRAILER_BYTES = 13;
const NONCE_BYTES = 12;
const VERSION = 2;
const MAGIC = 'CBSF';
type Bytes = Uint8Array<ArrayBuffer>;

export interface DirectBlobDownloadPlan {
  url: string;
  keyBase64: string;
}

function base64Bytes(value: string): Bytes {
  const raw = atob(value);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

function magic(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes.subarray(0, 4));
}

async function range(url: string, value: string): Promise<{ bytes: Bytes; total: number }> {
  const response = await fetch(url, { headers: { Range: value } });
  if (response.status !== 206) throw new Error('provider did not honor CBSF range read');
  const match = response.headers.get('content-range')?.match(/\/([0-9]+)$/);
  if (!match) throw new Error('provider did not expose Content-Range');
  return { bytes: new Uint8Array(await response.arrayBuffer()), total: Number(match[1]) };
}

function aad(value: string): Bytes {
  return new TextEncoder().encode(value);
}

async function openGcm(key: CryptoKey, sealed: Bytes, additionalData: Bytes): Promise<Bytes> {
  if (sealed.byteLength < NONCE_BYTES + 16) throw new Error('sealed CBSF value is truncated');
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: sealed.subarray(0, NONCE_BYTES),
        additionalData,
        tagLength: 128,
      },
      key,
      sealed.subarray(NONCE_BYTES),
    ),
  );
}

async function unpackFrame(body: Bytes): Promise<Bytes> {
  const algorithm = body[0];
  const payload = body.slice(1);
  if (algorithm === 0) return payload;
  if (algorithm === 2 && typeof DecompressionStream !== 'undefined') {
    const stream = new Blob([payload.buffer])
      .stream()
      .pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  throw new Error(`browser cannot open CBSF compression algorithm ${algorithm}`);
}

function decodeDirectory(
  bytes: Bytes,
  frameCount: number,
): {
  totalSize: number;
  sealedLens: number[];
} {
  if (bytes.byteLength !== 16 + frameCount * 4) throw new Error('CBSF directory size mismatch');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const totalSize = Number(view.getBigUint64(4, false));
  const encodedCount = view.getUint32(12, false);
  if (!Number.isSafeInteger(totalSize) || encodedCount !== frameCount) {
    throw new Error('CBSF directory metadata mismatch');
  }
  return {
    totalSize,
    sealedLens: Array.from({ length: frameCount }, (_, index) =>
      view.getUint32(16 + index * 4, false),
    ),
  };
}

/** Fetch and locally unseal a remote-primary blob using bounded provider ranges. */
export async function readDirectBlob(
  plan: DirectBlobDownloadPlan,
  sha256: string,
  mediaType: string,
): Promise<Blob> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('direct read needs sha256');
  const key = await crypto.subtle.importKey(
    'raw',
    base64Bytes(plan.keyBase64).buffer,
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  );
  const trailerRead = await range(plan.url, `bytes=-${TRAILER_BYTES}`);
  const trailer = trailerRead.bytes;
  if (trailer.byteLength !== TRAILER_BYTES || magic(trailer) !== MAGIC || trailer[4] !== VERSION) {
    throw new Error('provider object is not CBSF v2');
  }
  const trailerView = new DataView(trailer.buffer, trailer.byteOffset, trailer.byteLength);
  const directoryLength = trailerView.getUint32(5, false);
  const frameCount = trailerView.getUint32(9, false);
  const directoryStart = trailerRead.total - TRAILER_BYTES - directoryLength;
  if (directoryStart < HEADER_BYTES) throw new Error('CBSF directory offset is invalid');

  const [headerRead, directoryRead] = await Promise.all([
    range(plan.url, `bytes=0-${HEADER_BYTES - 1}`),
    range(plan.url, `bytes=${directoryStart}-${trailerRead.total - TRAILER_BYTES - 1}`),
  ]);
  const header = headerRead.bytes;
  const headerSha = [...header.subarray(5, HEADER_BYTES)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  if (
    header.byteLength !== HEADER_BYTES ||
    magic(header) !== MAGIC ||
    header[4] !== VERSION ||
    headerSha !== sha256
  ) {
    throw new Error('CBSF header identity mismatch');
  }
  const directoryPlain = await openGcm(
    key,
    directoryRead.bytes,
    aad(`blobdir:${sha256}:v${VERSION}:n${frameCount}`),
  );
  const directory = decodeDirectory(directoryPlain, frameCount);
  const parts: BlobPart[] = [];
  let offset = HEADER_BYTES;
  let plaintextBytes = 0;
  for (let index = 0; index < directory.sealedLens.length; index += 1) {
    const length = directory.sealedLens[index]!;
    const frame = await range(plan.url, `bytes=${offset}-${offset + length - 1}`);
    if (frame.bytes.byteLength !== length) throw new Error('provider returned a short CBSF frame');
    const opened = await openGcm(
      key,
      frame.bytes,
      aad(`blob:${sha256}:v${VERSION}:f${index}/${frameCount}`),
    );
    const plain = await unpackFrame(opened);
    parts.push(plain.buffer);
    plaintextBytes += plain.byteLength;
    offset += length;
  }
  if (plaintextBytes !== directory.totalSize) throw new Error('CBSF plaintext size mismatch');
  return new Blob(parts, { type: mediaType });
}
