/*
 * REVEAL DECRYPTS LOCALLY (#996, ruling R13).
 *
 * The mirror of `packages/vault/src/gateway/locker-key-plane.ts`, in
 * WebCrypto, because the seat is where a secret becomes readable now. Same
 * wire form, same AAD, same refusals — a second implementation of a
 * cryptographic envelope is a place for the two to drift, so the envelope is
 * stated once here in the terms the other file states it in, and the tests on
 * both sides encrypt on one and decrypt on the other.
 *
 * OFFLINE IS THE POINT. Nothing in this module talks to a gateway. A phone in
 * airplane mode holds `vault.db` and `K`; a reveal is a decryption, not a
 * request, and there is no round trip to fail.
 */

/** Wire prefix — the "is this ciphertext?" predicate, shared with the vault. */
export const LOCKER_CIPHERTEXT_PREFIX = "lk1:";

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** A write whose key the vault has rotated past. The message is R13's. */
export class StaleLockerKeyError extends Error {
  constructor(
    readonly rowKeyId: string,
    readonly heldKeyId: string
  ) {
    super("re-enter this secret");
    this.name = "StaleLockerKeyError";
  }
}

function unbase64(value: string): Uint8Array {
  if (typeof globalThis.atob === "function") {
    const binary = globalThis.atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(value, "base64"));
}

function base64(bytes: Uint8Array): string {
  if (typeof globalThis.btoa === "function") {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return globalThis.btoa(binary);
  }
  return Buffer.from(bytes).toString("base64");
}

export function isLockerCiphertext(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith(LOCKER_CIPHERTEXT_PREFIX))
    return false;
  const body = value.slice(LOCKER_CIPHERTEXT_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(body) || body.length % 4 !== 0)
    return false;
  return unbase64(body).byteLength >= NONCE_BYTES + TAG_BYTES;
}

/** AAD binding a ciphertext to its row AND its key: `<rowId>‖<keyId>`. */
export function lockerAad(rowId: string, keyId: string): Uint8Array {
  return new TextEncoder().encode(`${rowId}‖${keyId}`);
}

async function aesKey(key: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    "AES-GCM",
    false,
    [usage]
  );
}

/**
 * Refuse a write whose key the vault has moved past.
 *
 * Checked HERE, before the intent is posted. The seat is the only place that
 * can still do something useful about it: it has the plaintext in hand, so it
 * can ask the owner to re-enter rather than discovering the problem after the
 * value has left. The gateway's own copy of this check is
 * `assertLiveLockerKeyId` in `locker-key-plane.ts`, which is what makes it a
 * rule rather than a courtesy — its call site on the write path lands with
 * the Locker write commands.
 */
export function assertLockerKeyIdLive(
  rowKeyId: string | null | undefined,
  heldKeyId: string
): void {
  // A row with no key id holds no ciphertext — it predates the plane and is
  // adopted by the live key on the next write.
  if (rowKeyId === null || rowKeyId === undefined || rowKeyId === heldKeyId)
    return;
  throw new StaleLockerKeyError(rowKeyId, heldKeyId);
}

/** Encrypt one secret under `K`, on the seat, for an offline intent. */
export async function encryptLockerSecret(
  vault: { keyId: string; key: Uint8Array },
  rowId: string,
  plaintext: string
): Promise<string> {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce as BufferSource,
        additionalData: lockerAad(rowId, vault.keyId) as BufferSource,
      },
      await aesKey(vault.key, "encrypt"),
      new TextEncoder().encode(plaintext) as BufferSource
    )
  );
  const out = new Uint8Array(nonce.length + sealed.length);
  out.set(nonce, 0);
  out.set(sealed, nonce.length);
  return LOCKER_CIPHERTEXT_PREFIX + base64(out);
}

/**
 * Decrypt one secret. Throws on tampering, on a wrong row, and — before it
 * gets that far — on a row the held key cannot be the right one for.
 */
export async function decryptLockerSecret(
  vault: { keyId: string; key: Uint8Array },
  row: { id: string; keyId?: string | null },
  value: string
): Promise<string> {
  assertLockerKeyIdLive(row.keyId, vault.keyId);
  if (!isLockerCiphertext(value))
    throw new Error("value is not locker ciphertext");
  const raw = unbase64(value.slice(LOCKER_CIPHERTEXT_PREFIX.length));
  const opened = await globalThis.crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: raw.subarray(0, NONCE_BYTES) as BufferSource,
      additionalData: lockerAad(row.id, vault.keyId) as BufferSource,
    },
    await aesKey(vault.key, "decrypt"),
    raw.subarray(NONCE_BYTES) as BufferSource
  );
  return new TextDecoder().decode(opened);
}
