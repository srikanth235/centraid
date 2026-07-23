/*
 * Key custody and object encryption (FORMAT.md § Key custody, § Encryption).
 * AES-256-GCM everywhere: `iv (12 bytes) || ciphertext || tag (16 bytes)`.
 * Per-vault keys derive from the keyring's active epoch via HKDF-SHA256 with
 * the exact info strings FORMAT.md specifies — changing either string would
 * silently re-key every vault, so they're `const`, not templated loosely.
 *
 * Format /1 (issue #408) makes every object nonce DETERMINISTIC — derived by HKDF
 * from the object's identity rather than `randomBytes` — so a retried upload
 * is byte-identical to the first attempt (G7). Safety rests on the derivation
 * inputs never repeating with different plaintext: chunk nonces derive from
 * the chunk's own keyed content hash, WAL-segment nonces from the full
 * `(db, generation, group, startOffset, endOffset)` address (offsets are
 * monotonic within a group, generations are random 128-bit — and including
 * BOTH offsets means a crash-retry that re-reads a LONGER range from the
 * same start gets a fresh nonce, never a reused one).
 */

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Encrypt `plain` under `key` (32 bytes) with a random nonce: `iv || ciphertext || tag`. */
export function encrypt(key: Uint8Array, plain: Uint8Array): Uint8Array {
  return encryptWithNonce(key, randomBytes(IV_BYTES), plain);
}

/**
 * Encrypt with a caller-supplied 12-byte nonce (use `deriveNonce` — never a
 * counter, never a reused tuple) and optional additional authenticated data.
 * Same wire shape as `encrypt`: `nonce || ciphertext || tag`.
 */
export function encryptWithNonce(
  key: Uint8Array,
  nonce: Uint8Array,
  plain: Uint8Array,
  aad?: Uint8Array,
): Uint8Array {
  if (nonce.length !== IV_BYTES) throw new Error(`nonce must be ${IV_BYTES} bytes`);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  if (aad) cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return new Uint8Array(Buffer.concat([nonce, ct, tag]));
}

/** Decrypt an `encrypt()`/`encryptWithNonce()` blob. Throws (auth tag failure) on any tampering. */
export function decrypt(key: Uint8Array, blob: Uint8Array, aad?: Uint8Array): Uint8Array {
  if (blob.length < IV_BYTES + TAG_BYTES) throw new Error('encrypted blob truncated');
  const buf = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const ct = buf.subarray(IV_BYTES, buf.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([decipher.update(ct), decipher.final()]));
}

/**
 * A deterministic 12-byte GCM nonce: `HKDF(key, salt=∅, info)[0..12)`. The
 * caller's `info` string IS the uniqueness argument — it must be injective
 * over everything ever sealed under `key` (FORMAT.md § Encryption lists the
 * exact info strings per object kind; they are format-normative).
 */
export function deriveNonce(key: Uint8Array, info: string): Uint8Array {
  const out = hkdfSync(
    'sha256',
    Buffer.from(key.buffer, key.byteOffset, key.byteLength),
    Buffer.alloc(0),
    Buffer.from(info, 'utf8'),
    IV_BYTES,
  );
  return new Uint8Array(out);
}

/** `dataKey = HKDF(master, salt=∅, info="centraid-backup:data:" + vaultId)`. */
export function deriveDataKey(master: Uint8Array, vaultId: string): Uint8Array {
  return hkdfDerive(master, `centraid-backup:data:${vaultId}`);
}

/** `dedupKey = HKDF(master, salt=∅, info="centraid-backup:dedup:" + vaultId)`. */
export function deriveDedupKey(master: Uint8Array, vaultId: string): Uint8Array {
  return hkdfDerive(master, `centraid-backup:dedup:${vaultId}`);
}

function hkdfDerive(master: Uint8Array, info: string): Uint8Array {
  const out = hkdfSync(
    'sha256',
    Buffer.from(master.buffer, master.byteOffset, master.byteLength),
    Buffer.alloc(0),
    Buffer.from(info, 'utf8'),
    KEY_BYTES,
  );
  return new Uint8Array(out);
}

/** `chunkId = HMAC-SHA256(dedupKey, plaintextChunkBytes)` (hex). */
export function chunkId(dedupKey: Uint8Array, plain: Uint8Array): string {
  return createHmac(
    'sha256',
    Buffer.from(dedupKey.buffer, dedupKey.byteOffset, dedupKey.byteLength),
  )
    .update(Buffer.from(plain.buffer, plain.byteOffset, plain.byteLength))
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Keyring (FORMAT.md § Key custody — epochs)
// ---------------------------------------------------------------------------
// Mutation ownership for #532 is the pure seal/HKDF surface above (property
// suite). Keyring I/O is covered by crypto.test.ts unit tests, not the
// property/mutation mutate set.
// Stryker disable all

export interface KeyringEpoch {
  epoch: number;
  /** base64 32 bytes. */
  key: string;
  createdAt: string;
}

export interface Keyring {
  version: 1;
  active: number;
  epochs: KeyringEpoch[];
}

function epochOf(keyring: Keyring, epoch: number): KeyringEpoch {
  const found = keyring.epochs.find((e) => e.epoch === epoch);
  if (!found) throw new Error(`keyring has no epoch ${epoch}`);
  return found;
}

/** The active epoch's master key, decoded from base64. */
export function activeMasterKey(keyring: Keyring): { epoch: number; key: Uint8Array } {
  const e = epochOf(keyring, keyring.active);
  return { epoch: e.epoch, key: new Uint8Array(Buffer.from(e.key, 'base64')) };
}

/** A specific epoch's master key (needed to read snapshots written under an old epoch). */
export function masterKeyForEpoch(keyring: Keyring, epoch: number): Uint8Array {
  return new Uint8Array(Buffer.from(epochOf(keyring, epoch).key, 'base64'));
}

/** Validate an untyped JSON value as a `Keyring` (FORMAT.md § Key custody).
 *  Exported (issue #439) so the recovery-kit reader can validate the keyring
 *  it carries with the SAME rules `loadKeyring` holds a file to — a kit whose
 *  keyring is malformed is rejected before a single provider call. */
export function validateKeyring(value: unknown): Keyring {
  if (typeof value !== 'object' || value === null) throw new Error('keyring: not an object');
  const v = value as Record<string, unknown>;
  if (v['version'] !== 1) throw new Error('keyring: unsupported version');
  if (typeof v['active'] !== 'number') throw new Error('keyring: missing "active"');
  if (!Array.isArray(v['epochs']) || v['epochs'].length === 0) {
    throw new Error('keyring: missing "epochs"');
  }
  for (const e of v['epochs'] as unknown[]) {
    if (typeof e !== 'object' || e === null) throw new Error('keyring: malformed epoch');
    const ee = e as Record<string, unknown>;
    if (typeof ee['epoch'] !== 'number') throw new Error('keyring: epoch missing "epoch"');
    if (typeof ee['key'] !== 'string' || Buffer.from(ee['key'], 'base64').length !== KEY_BYTES) {
      throw new Error('keyring: epoch key must be base64 of 32 bytes');
    }
    if (typeof ee['createdAt'] !== 'string') throw new Error('keyring: epoch missing "createdAt"');
  }
  if (!(v['epochs'] as { epoch: number }[]).some((e) => e.epoch === v['active'])) {
    throw new Error('keyring: "active" does not name an existing epoch');
  }
  return value as Keyring;
}

/** Load and validate a keyring file. */
export async function loadKeyring(file: string): Promise<Keyring> {
  const raw = await fs.readFile(file, 'utf8');
  return validateKeyring(JSON.parse(raw));
}

/** Atomic write (temp + rename), file mode 0600 — the keyring carries live key material. */
export async function saveKeyring(file: string, keyring: Keyring): Promise<void> {
  validateKeyring(keyring);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(keyring, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
}

/** Mint a fresh single-epoch keyring at `file`. Refuses to overwrite an existing file. */
export async function createKeyring(file: string): Promise<Keyring> {
  try {
    await fs.access(file);
    throw new Error(`keyring already exists at ${file} — refusing to overwrite`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const keyring: Keyring = {
    version: 1,
    active: 1,
    epochs: [
      {
        epoch: 1,
        key: randomBytes(KEY_BYTES).toString('base64'),
        createdAt: new Date().toISOString(),
      },
    ],
  };
  await saveKeyring(file, keyring);
  return keyring;
}

/**
 * Rotation = a new epoch (FORMAT.md): old epochs are retained (so old
 * snapshots stay readable) and the new epoch becomes active (so new
 * snapshots — and the first post-rotation snapshot's full re-upload — use
 * it). Dedup does not span epochs; this function only manages key custody,
 * the re-upload consequence lives in `engine.ts`.
 */
export async function rotateKeyring(file: string): Promise<Keyring> {
  const keyring = await loadKeyring(file);
  const nextEpoch = Math.max(...keyring.epochs.map((e) => e.epoch)) + 1;
  const rotated: Keyring = {
    version: 1,
    active: nextEpoch,
    epochs: [
      ...keyring.epochs,
      {
        epoch: nextEpoch,
        key: randomBytes(KEY_BYTES).toString('base64'),
        createdAt: new Date().toISOString(),
      },
    ],
  };
  await saveKeyring(file, rotated);
  return rotated;
}
