// The sealed column class (issue #293): secrets as a first-class data class
// across the whole §10 pipeline. Sealing is a PIPELINE property, not a
// storage feature — a column declared here is (1) ciphertext at rest,
// (2) a placeholder in every default read including the owner's SQL surface,
// (3) revealable only under the `reveal` scope verb with a per-item receipt,
// (4) hash-not-value in the append-only journal, (5) structurally excluded
// from FTS, and (6) sealed at stage time in the import draft band. One
// declaration, six enforcement points — none of them per-app convention.
//
// Crypto shape: AES-256-GCM per value, random 12-byte nonce, the physical
// `table.column:rowid` as AAD so a ciphertext cannot be swapped between rows
// or columns. Wire form `sealed:v1:<base64(nonce|ciphertext|tag)>` — the
// prefix doubles as the "is this sealed?" predicate everywhere.
//
// Key custody (v0): one data-encryption key per vault, load-or-created in a
// `keys/` SIBLING of the vault directory — deterministic for every opener,
// and deliberately OUTSIDE the directory that export/backup/copy gestures
// move around, so a copied vault carries ciphertext only. Honest scope: this
// protects the files at rest and in backups, not against an attacker who
// owns the running gateway process (which must unseal to serve reveals).
// In-memory vaults (tests) get an ephemeral random key.

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The registry: logical entity → its sealed columns. Sealing is per-column —
 * `locker_item.title` and `username` stay plain and searchable; that is what
 * makes Locker usable as a projection while the secret material is sealed.
 */
export const SEALED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  'locker.item': ['password', 'otp_seed', 'card_number', 'cvv', 'content'],
};

/** Sealed columns of a logical entity ([] for everything unsealed). */
export function sealedColumnsOf(entity: string): readonly string[] {
  return SEALED_COLUMNS[entity] ?? [];
}

/**
 * Staged-payload keys carrying secret material, per entity type (issue #293
 * decision 6): the import draft band deserves the same protection as the
 * live band, so these seal at stage time and unseal just-in-time for the
 * publisher. Keys are payload-shaped (camelCase), not column names.
 */
export const SEALED_PAYLOAD_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'locker.item': ['password', 'otpSeed'],
};

export function sealedPayloadFieldsOf(entityType: string): readonly string[] {
  return SEALED_PAYLOAD_FIELDS[entityType] ?? [];
}

/** Wire prefix of a sealed value — the "is this sealed?" predicate. */
export const SEALED_PREFIX = 'sealed:v1:';

/** What default reads (and the SQL surface) show instead of a secret. */
export const SEALED_PLACEHOLDER = '«sealed»';

export function isSealedValue(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SEALED_PREFIX);
}

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** AAD binding a ciphertext to its exact cell: `physical.column:rowId`. */
export function sealAad(physical: string, column: string, rowId: string): string {
  return `${physical}.${column}:${rowId}`;
}

/** Encrypt one plaintext into the sealed wire form. */
export function sealValue(key: Buffer, aad: string, plaintext: string): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return SEALED_PREFIX + Buffer.concat([nonce, ct, tag]).toString('base64');
}

/** Decrypt a sealed wire value. Throws on tampering or a wrong cell (AAD). */
export function unsealValue(key: Buffer, aad: string, sealed: string): string {
  if (!sealed.startsWith(SEALED_PREFIX)) {
    throw new Error('value is not sealed');
  }
  const raw = Buffer.from(sealed.slice(SEALED_PREFIX.length), 'base64');
  if (raw.length < NONCE_BYTES + TAG_BYTES) throw new Error('sealed value truncated');
  const nonce = raw.subarray(0, NONCE_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const ct = raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** Fresh random key for in-memory vaults (tests) — never persisted. */
export function ephemeralSealKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/**
 * Load (or mint, 0600) the vault's DEK. The conventional location for a
 * vault at `<root>/<name>/` is `<root>/keys/<name>.sealkey` — see
 * `sealKeyFileFor`.
 */
export function loadOrCreateSealKey(file: string): Buffer {
  try {
    const key = readFileSync(file);
    if (key.length === KEY_BYTES) return key;
    throw new Error(`seal key at ${file} is ${key.length} bytes, expected ${KEY_BYTES}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const key = randomBytes(KEY_BYTES);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, key, { mode: 0o600 });
  return key;
}

/** Deterministic key path for a vault directory: the `keys/` sibling. */
export function sealKeyFileFor(vaultDir: string): string {
  const parent = path.dirname(path.resolve(vaultDir));
  return path.join(parent, 'keys', `${path.basename(path.resolve(vaultDir))}.sealkey`);
}

/**
 * Journal-safe token for a sealed input value: a truncated keyed hash. Lets
 * the audit trail say "the same value was submitted twice" without ever
 * being reversible to the value. Keyed by the vault DEK so the token is
 * useless for offline dictionary attacks against a copied journal.
 */
export function sealedHashToken(key: Buffer, value: string): string {
  const mac = createHmac('sha256', key).update(value).digest('hex').slice(0, 16);
  return `sealed:sha256:${mac}`;
}

/**
 * Redact declared sealed paths of a command input for the journal (issue
 * #293 decision 4): the append-only journal must never see the value — the
 * first leak would be permanent. Non-string / absent paths pass through.
 */
export function redactSealedInput(
  key: Buffer,
  input: Record<string, unknown>,
  sealedPaths: readonly string[],
): Record<string, unknown> {
  if (sealedPaths.length === 0) return input;
  const out: Record<string, unknown> = { ...input };
  for (const p of sealedPaths) {
    const v = out[p];
    if (typeof v === 'string' && v.length > 0 && !isSealedValue(v)) {
      out[p] = sealedHashToken(key, v);
    }
  }
  return out;
}
