export interface UploadCrypto {
  sealGcm: (
    key: Uint8Array,
    nonce: Uint8Array,
    additionalData: Uint8Array,
    plain: Uint8Array
  ) => Promise<Uint8Array>;
  hmacSha256: (
    key: Uint8Array,
    ...parts: readonly Uint8Array[]
  ) => Promise<Uint8Array>;
}

export class UploadCryptoUnavailableError extends Error {
  constructor() {
    super(
      "Edge sealing needs globalThis.crypto.subtle (AES-GCM + HMAC). Install a WebCrypto " +
        "polyfill at app boot before draining the upload queue."
    );
    this.name = "UploadCryptoUnavailableError";
  }
}

/* oxlint-disable typescript/method-signature-style -- This interface is a
   structural stand-in for the DOM's `SubtleCrypto`, and must stay assignable
   FROM it: the real `importKey`/`encrypt` accept much wider `format` and
   `algorithm` unions than the narrow subset spelled out here. Method
   shorthand is bivariant, property style is contravariant under
   `strictFunctionTypes` — as property style, no real WebCrypto implementation
   satisfies this type. The bivariance is the point, not an oversight. */
export interface SubtleCryptoLike {
  importKey(
    format: "raw",
    keyData: ArrayBuffer,
    algorithm: { name: "AES-GCM" } | { name: "HMAC"; hash: "SHA-256" },
    extractable: boolean,
    keyUsages: readonly string[]
  ): Promise<CryptoKeyLike>;
  encrypt(
    algorithm: {
      name: "AES-GCM";
      iv: ArrayBuffer;
      additionalData: ArrayBuffer;
    },
    key: CryptoKeyLike,
    data: ArrayBuffer
  ): Promise<ArrayBuffer>;
  sign(
    algorithm: "HMAC",
    key: CryptoKeyLike,
    data: ArrayBuffer
  ): Promise<ArrayBuffer>;
}
/* oxlint-enable typescript/method-signature-style */

export type CryptoKeyLike = object;

export function webCryptoUploadCrypto(subtle?: SubtleCryptoLike): UploadCrypto {
  const impl = subtle ?? globalThis.crypto?.subtle;
  if (!impl) throw new UploadCryptoUnavailableError();
  return {
    async sealGcm(key, nonce, additionalData, plain) {
      const material = await impl.importKey(
        "raw",
        bufferOf(key),
        { name: "AES-GCM" },
        false,
        ["encrypt"]
      );
      const sealed = await impl.encrypt(
        {
          name: "AES-GCM",
          iv: bufferOf(nonce),
          additionalData: bufferOf(additionalData),
        },
        material,
        bufferOf(plain)
      );
      return new Uint8Array(sealed);
    },
    async hmacSha256(key, ...parts) {
      const material = await impl.importKey(
        "raw",
        bufferOf(key),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );
      let size = 0;
      for (const part of parts) size += part.byteLength;
      const joined = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        joined.set(part, offset);
        offset += part.byteLength;
      }
      return new Uint8Array(
        await impl.sign("HMAC", material, bufferOf(joined))
      );
    },
  };
}

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? (bytes.buffer as ArrayBuffer)
    : (bytes.slice().buffer as ArrayBuffer);
}
