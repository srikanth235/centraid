// The CBSF sealer's crypto seam (#419 M0.4).
//
// CBSF v2 needs AES-256-GCM (frames + directory) and HMAC-SHA-256 (nonce
// derivation). Hermes ships neither: `expo-crypto` is digest + random only,
// and RN 0.81 has no `crypto.subtle`. So the sealer takes its crypto by
// injection, exactly as M0.2 did for op-sqlite — a native module imported
// statically into a logic module breaks under vitest.
//
// The default implementation targets the WebCrypto `SubtleCrypto` API, which
// is what `packages/blueprints/kit/edge-upload.js` already seals with in the
// WebView. That makes it real (not a stub) in node/vitest today, and on device
// it needs only a `globalThis.crypto.subtle` polyfill installed at boot — see
// `index.ts`. No sealing logic changes between the two.

export interface UploadCrypto {
  /** AES-256-GCM. Returns `ciphertext || tag(16)`, matching WebCrypto. */
  sealGcm(
    key: Uint8Array,
    nonce: Uint8Array,
    additionalData: Uint8Array,
    plain: Uint8Array,
  ): Promise<Uint8Array>;
  /** HMAC-SHA-256 over the concatenated parts. */
  hmacSha256(key: Uint8Array, ...parts: readonly Uint8Array[]): Promise<Uint8Array>;
}

export class UploadCryptoUnavailableError extends Error {
  constructor() {
    super(
      'Edge sealing needs globalThis.crypto.subtle (AES-GCM + HMAC). Install a WebCrypto ' +
        'polyfill at app boot before draining the upload queue.',
    );
    this.name = 'UploadCryptoUnavailableError';
  }
}

/**
 * Exactly the WebCrypto surface the sealer touches — spelled out structurally
 * rather than as the DOM's `SubtleCrypto`, which RN's lib does not ship. This
 * doubles as the contract a device polyfill has to satisfy: raw key import for
 * AES-GCM and HMAC-SHA-256, `encrypt`, and `sign`.
 */
export interface SubtleCryptoLike {
  importKey(
    format: 'raw',
    keyData: ArrayBuffer,
    algorithm: { name: 'AES-GCM' } | { name: 'HMAC'; hash: 'SHA-256' },
    extractable: boolean,
    keyUsages: readonly string[],
  ): Promise<CryptoKeyLike>;
  encrypt(
    algorithm: { name: 'AES-GCM'; iv: ArrayBuffer; additionalData: ArrayBuffer },
    key: CryptoKeyLike,
    data: ArrayBuffer,
  ): Promise<ArrayBuffer>;
  sign(algorithm: 'HMAC', key: CryptoKeyLike, data: ArrayBuffer): Promise<ArrayBuffer>;
}

/** An opaque imported key handle; never inspected on this side. */
export type CryptoKeyLike = object;

/** Bind the sealer to a WebCrypto implementation (node, or a device polyfill). */
export function webCryptoUploadCrypto(subtle?: SubtleCryptoLike): UploadCrypto {
  const impl = subtle ?? (globalThis as { crypto?: { subtle?: SubtleCryptoLike } }).crypto?.subtle;
  if (!impl) throw new UploadCryptoUnavailableError();
  return {
    async sealGcm(key, nonce, additionalData, plain) {
      const material = await impl.importKey('raw', bufferOf(key), { name: 'AES-GCM' }, false, [
        'encrypt',
      ]);
      const sealed = await impl.encrypt(
        { name: 'AES-GCM', iv: bufferOf(nonce), additionalData: bufferOf(additionalData) },
        material,
        bufferOf(plain),
      );
      return new Uint8Array(sealed);
    },
    async hmacSha256(key, ...parts) {
      const material = await impl.importKey(
        'raw',
        bufferOf(key),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      let size = 0;
      for (const part of parts) size += part.byteLength;
      const joined = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        joined.set(part, offset);
        offset += part.byteLength;
      }
      return new Uint8Array(await impl.sign('HMAC', material, bufferOf(joined)));
    },
  };
}

/**
 * Hand WebCrypto a standalone ArrayBuffer. Views into a larger pooled buffer
 * (which `subarray` returns) are read whole by some polyfills, so slicing to
 * the exact window is the portable call.
 */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? (bytes.buffer as ArrayBuffer)
    : (bytes.slice().buffer as ArrayBuffer);
}
