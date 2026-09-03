import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function encrypt(key: Uint8Array, plain: Uint8Array): Uint8Array {
  return encryptWithNonce(key, randomBytes(IV_BYTES), plain);
}

export function encryptWithNonce(
  key: Uint8Array,
  nonce: Uint8Array,
  plain: Uint8Array,
  aad?: Uint8Array
): Uint8Array {
  if (nonce.length !== IV_BYTES)
    throw new Error(`nonce must be ${IV_BYTES} bytes`);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  if (aad) cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return new Uint8Array(Buffer.concat([nonce, ct, tag]));
}

export function decrypt(
  key: Uint8Array,
  blob: Uint8Array,
  aad?: Uint8Array
): Uint8Array {
  if (blob.length < IV_BYTES + TAG_BYTES)
    throw new Error("encrypted blob truncated");
  const buf = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const ct = buf.subarray(IV_BYTES, buf.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([decipher.update(ct), decipher.final()]));
}

export function deriveNonce(key: Uint8Array, info: string): Uint8Array {
  const out = hkdfSync(
    "sha256",
    Buffer.from(key.buffer, key.byteOffset, key.byteLength),
    Buffer.alloc(0),
    Buffer.from(info, "utf8"),
    IV_BYTES
  );
  return new Uint8Array(out);
}

export function deriveDataKey(master: Uint8Array, vaultId: string): Uint8Array {
  return hkdfDerive(master, `centraid-backup:data:${vaultId}`);
}

export function deriveDedupKey(
  master: Uint8Array,
  vaultId: string
): Uint8Array {
  return hkdfDerive(master, `centraid-backup:dedup:${vaultId}`);
}

function hkdfDerive(master: Uint8Array, info: string): Uint8Array {
  const out = hkdfSync(
    "sha256",
    Buffer.from(master.buffer, master.byteOffset, master.byteLength),
    Buffer.alloc(0),
    Buffer.from(info, "utf8"),
    KEY_BYTES
  );
  return new Uint8Array(out);
}

export function chunkId(dedupKey: Uint8Array, plain: Uint8Array): string {
  return createHmac(
    "sha256",
    Buffer.from(dedupKey.buffer, dedupKey.byteOffset, dedupKey.byteLength)
  )
    .update(Buffer.from(plain.buffer, plain.byteOffset, plain.byteLength))
    .digest("hex");
}

export interface KeyringEpoch {
  epoch: number;
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

export function activeMasterKey(keyring: Keyring): {
  epoch: number;
  key: Uint8Array;
} {
  const e = epochOf(keyring, keyring.active);
  return { epoch: e.epoch, key: new Uint8Array(Buffer.from(e.key, "base64")) };
}

export function masterKeyForEpoch(keyring: Keyring, epoch: number): Uint8Array {
  return new Uint8Array(Buffer.from(epochOf(keyring, epoch).key, "base64"));
}

export function validateKeyring(value: unknown): Keyring {
  if (typeof value !== "object" || value === null)
    throw new Error("keyring: not an object");
  const v = value as Record<string, unknown>;
  if (v["version"] !== 1) throw new Error("keyring: unsupported version");
  if (typeof v["active"] !== "number")
    throw new Error('keyring: missing "active"');
  if (!Array.isArray(v["epochs"]) || v["epochs"].length === 0) {
    throw new Error('keyring: missing "epochs"');
  }
  for (const e of v["epochs"] as unknown[]) {
    if (typeof e !== "object" || e === null)
      throw new Error("keyring: malformed epoch");
    const ee = e as Record<string, unknown>;
    if (typeof ee["epoch"] !== "number")
      throw new Error('keyring: epoch missing "epoch"');
    if (
      typeof ee["key"] !== "string" ||
      Buffer.from(ee["key"], "base64").length !== KEY_BYTES
    ) {
      throw new Error("keyring: epoch key must be base64 of 32 bytes");
    }
    if (typeof ee["createdAt"] !== "string")
      throw new Error('keyring: epoch missing "createdAt"');
  }
  if (
    !(v["epochs"] as { epoch: number }[]).some((e) => e.epoch === v["active"])
  ) {
    throw new Error('keyring: "active" does not name an existing epoch');
  }
  return value as Keyring;
}

export async function loadKeyring(file: string): Promise<Keyring> {
  const raw = await fs.readFile(file, "utf8");
  return validateKeyring(JSON.parse(raw));
}

export async function saveKeyring(
  file: string,
  keyring: Keyring
): Promise<void> {
  validateKeyring(keyring);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(keyring, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.rename(tmp, file);
}

export async function createKeyring(file: string): Promise<Keyring> {
  try {
    await fs.access(file);
    throw new Error(
      `keyring already exists at ${file} — refusing to overwrite`
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const keyring: Keyring = {
    version: 1,
    active: 1,
    epochs: [
      {
        epoch: 1,
        key: randomBytes(KEY_BYTES).toString("base64"),
        createdAt: new Date().toISOString(),
      },
    ],
  };
  await saveKeyring(file, keyring);
  return keyring;
}

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
        key: randomBytes(KEY_BYTES).toString("base64"),
        createdAt: new Date().toISOString(),
      },
    ],
  };
  await saveKeyring(file, rotated);
  return rotated;
}
