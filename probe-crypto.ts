export type CryptoKeyLike = object;

export interface SubtleCryptoLikeC {
  importKey: (
    format: "raw",
    keyData: ArrayBuffer,
    algorithm: { name: "AES-GCM" } | { name: "HMAC"; hash: "SHA-256" },
    extractable: boolean,
    keyUsages: readonly ("encrypt" | "sign")[]
  ) => Promise<CryptoKeyLike>;
  encrypt: (
    algorithm: {
      name: "AES-GCM";
      iv: ArrayBuffer;
      additionalData: ArrayBuffer;
    },
    key: CryptoKeyLike,
    data: ArrayBuffer
  ) => Promise<ArrayBuffer>;
  sign: (
    algorithm: "HMAC",
    key: CryptoKeyLike,
    data: ArrayBuffer
  ) => Promise<ArrayBuffer>;
}

export const c = (globalThis as { crypto?: { subtle?: SubtleCryptoLikeC } })
  .crypto?.subtle;
