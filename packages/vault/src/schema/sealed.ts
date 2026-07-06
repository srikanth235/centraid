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
// Key custody (v0): one data-encryption key per vault, minted at first need
// in a `keys/` SIBLING of the vault directory — deterministic for every
// opener, and deliberately OUTSIDE the directory that export/backup/copy
// gestures move around, so a copied vault carries ciphertext only. Honest
// scope: this protects the files at rest and in backups, not against an
// attacker who owns the running gateway process (which must unseal to serve
// reveals). In-memory vaults (tests) get an ephemeral random key.
//
// Lifecycle honesty (issue #298 item 1): once a vault has EVER sealed a
// value, its key fingerprint is stamped into `core_vault.settings_json`. At
// open time the loaded key must match that stamp — a missing or regenerated
// key is a loud, distinguishable SealKeyError at OPEN, never a silent
// re-mint discovered as GCM garbage at reveal. A vault that has never sealed
// may still mint freely (nothing is lost by a fresh key).
//
// Recovery story (issue #298 item 2, decided): the key is exportable and
// restorable ONLY through the explicit, receipted `key export` / `key
// restore` admin gestures — copying the vault directory backs up ciphertext
// only, and the product says so out loud when the key is absent at open.

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/**
 * The registry: logical entity → its sealed columns. Sealing is per-column —
 * `locker_item.title` and `username` stay plain and searchable; that is what
 * makes Locker usable as a projection while the secret material is sealed.
 */
export const SEALED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  'locker.item': ['password', 'otp_seed', 'card_number', 'cvv', 'content'],
  // Broker-owned credentials (issue #304): tokens live on the connection's
  // credential sidecar so the gateway broker can inject them; every read
  // surface shows a placeholder and reseal covers them like any secret cell.
  'sync.connection_credential': ['client_secret', 'access_token', 'refresh_token', 'api_key'],
};

/**
 * Sealed columns of a logical entity ([] for everything unsealed). Canonical
 * entities resolve from the static registry above; ext-band entities (issue
 * #298 item 9) resolve their declared `sealed` list from `consent_app_ext`
 * when a vault handle is supplied — so a third-party app's sealed column
 * reaches the exact same chokepoints (seal sweep, read placeholder, reveal
 * gate) as `locker.item.password`.
 */
export function sealedColumnsOf(entity: string, vault?: DatabaseSync): readonly string[] {
  const canonical = SEALED_COLUMNS[entity];
  if (canonical) return canonical;
  if (vault && (entity.startsWith('ext.') || entity.startsWith('extdraft.'))) {
    return extSealedColumns(vault, entity);
  }
  return [];
}

/** Read one ext table's declared `sealed` list from the band registry. */
function extSealedColumns(vault: DatabaseSync, entity: string): readonly string[] {
  const parts = entity.split('.');
  if (parts.length !== 3) return [];
  const [prefix, appId, table] = parts;
  const band = prefix === 'ext' ? 'live' : prefix === 'extdraft' ? 'draft' : null;
  if (!band || !appId || !table) return [];
  try {
    const row = vault
      .prepare(
        `SELECT spec_json FROM consent_app_ext WHERE app_id = ? AND band = ? AND table_name = ?`,
      )
      .get(appId, band, table) as { spec_json: string } | undefined;
    if (!row) return [];
    const sealed = (JSON.parse(row.spec_json) as { sealed?: unknown }).sealed;
    return Array.isArray(sealed) ? (sealed.filter((c) => typeof c === 'string') as string[]) : [];
  } catch {
    return [];
  }
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

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

// A genuine sealed payload is base64(nonce|ct|tag) — at least 28 bytes, so
// at least 40 base64 chars of strict alphabet. Requiring the shape (issue
// #298 item 8) keeps the prefix predicate structural: a user password that
// happens to START with "sealed:v1:" no longer satisfies it, so the seal
// sweep seals it instead of storing it verbatim as "already sealed".
const SEALED_BODY_RE = /^[A-Za-z0-9+/]{38,}={0,2}$/;

export function isSealedValue(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith(SEALED_PREFIX)) return false;
  const body = value.slice(SEALED_PREFIX.length);
  if (!SEALED_BODY_RE.test(body) || body.length % 4 !== 0) return false;
  return Buffer.from(body, 'base64').length >= NONCE_BYTES + TAG_BYTES;
}

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
 * Load the vault's DEK, or null when no key file exists. A present-but-wrong
 * file (bad length) always throws — that is corruption, never a fresh vault.
 */
export function loadSealKey(file: string): Buffer | null {
  try {
    const key = readFileSync(file);
    if (key.length === KEY_BYTES) return key;
    throw new Error(`seal key at ${file} is ${key.length} bytes, expected ${KEY_BYTES}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return null;
  }
}

/** Persist a DEK at `file` (0600, parent dirs created). */
export function writeSealKeyFile(file: string, key: Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, key, { mode: 0o600 });
}

/** Mint (0600) a fresh DEK at `file`. Creation is deliberate, never a fallback. */
export function createSealKey(file: string): Buffer {
  const key = randomBytes(KEY_BYTES);
  writeSealKeyFile(file, key);
  return key;
}

/** Deterministic key path for a vault directory: the `keys/` sibling. */
export function sealKeyFileFor(vaultDir: string): string {
  const parent = path.dirname(path.resolve(vaultDir));
  return path.join(parent, 'keys', `${path.basename(path.resolve(vaultDir))}.sealkey`);
}

/**
 * Non-secret identity of a DEK: a truncated SHA-256. Safe to stamp into
 * `core_vault.settings_json` and to print in error messages/receipts —
 * preimage-resistant, reveals nothing about the key.
 */
export function sealKeyFingerprint(key: Buffer): string {
  return `sha256:${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
}

/** Loud, distinguishable key-custody failure (issue #298 item 1). */
export class SealKeyError extends Error {
  constructor(
    readonly code: 'missing' | 'mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'SealKeyError';
  }
}

const SETTINGS_KEY = 'seal_key';

/** The fingerprint stamped at first seal, or null if this vault never sealed. */
export function readSealKeyFingerprint(vault: DatabaseSync): string | null {
  try {
    const row = vault.prepare('SELECT settings_json FROM core_vault LIMIT 1').get() as
      | { settings_json: string | null }
      | undefined;
    if (!row?.settings_json) return null;
    const bag = (JSON.parse(row.settings_json) as Record<string, unknown>)[SETTINGS_KEY];
    const fp =
      bag && typeof bag === 'object' ? (bag as { fingerprint?: unknown }).fingerprint : null;
    return typeof fp === 'string' && fp.length > 0 ? fp : null;
  } catch {
    return null;
  }
}

/**
 * Stamp the key's fingerprint into `core_vault.settings_json` — called by
 * every chokepoint that seals or unseals, so "this vault has secrets" is
 * recorded the moment it becomes true. Idempotent; a no-op before bootstrap
 * (no core_vault row yet) and when the stamp already matches.
 */
export function stampSealKeyFingerprint(vault: DatabaseSync, key: Buffer): void {
  const fp = sealKeyFingerprint(key);
  const row = vault.prepare('SELECT settings_json FROM core_vault LIMIT 1').get() as
    | { settings_json: string }
    | undefined;
  if (!row) return;
  const settings = JSON.parse(row.settings_json) as Record<string, unknown>;
  const bag = settings[SETTINGS_KEY] as { fingerprint?: string } | undefined;
  if (bag?.fingerprint === fp) return;
  settings[SETTINGS_KEY] = { fingerprint: fp, stamped_at: new Date().toISOString() };
  vault.prepare('UPDATE core_vault SET settings_json = ?').run(JSON.stringify(settings));
}

/**
 * Resolve the DEK for an on-disk vault (issue #298 item 1): load and verify
 * against the stamped fingerprint, minting only when provably safe.
 *
 * - Stamp present + key file missing → SealKeyError('missing'): the vault
 *   holds sealed secrets and this opener cannot decrypt them. Restoring the
 *   exported key (see `key restore`) is the only way back.
 * - Stamp present + wrong key → SealKeyError('mismatch'): a regenerated or
 *   foreign key would turn every sealed cell into GCM garbage — refuse at
 *   open, not at reveal. Before failing, a `<file>.next` sidecar left by an
 *   interrupted rotation (issue #298 item 8) is checked and promoted when it
 *   matches, completing the rotation crash-safely.
 * - No stamp → the vault never sealed anything; load-or-mint as before.
 */
export function resolveSealKey(vault: DatabaseSync, file: string): Buffer {
  const expected = readSealKeyFingerprint(vault);
  const key = loadSealKey(file);
  if (expected === null) return key ?? createSealKey(file);
  if (key && sealKeyFingerprint(key) === expected) return key;
  const next = loadSealKey(`${file}.next`);
  if (next && sealKeyFingerprint(next) === expected) {
    renameSync(`${file}.next`, file); // finish the interrupted rotation
    return next;
  }
  if (!key) {
    throw new SealKeyError(
      'missing',
      `seal key file missing at ${file} — this vault has sealed secrets (key ${expected}) and they are unrecoverable without that key. If you exported it, run \`key restore\`; a directory copy alone never carries the key.`,
    );
  }
  throw new SealKeyError(
    'mismatch',
    `seal key at ${file} (${sealKeyFingerprint(key)}) is not the key this vault's secrets were sealed with (${expected}) — refusing to open with a regenerated key. Restore the original via \`key restore\`.`,
  );
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

/**
 * Scrub declared secret input values out of free text (issue #298 item 7):
 * a handler error or SQLite constraint message that echoes its input would
 * otherwise carry the submitted secret into the journal, the receipt and the
 * HTTP error surface. Occurrences are replaced by the same keyed hash token
 * the journal uses, so the trail stays correlatable without being readable.
 */
export function scrubSealedText(key: Buffer, text: string, values: readonly string[]): string {
  let out = text;
  for (const v of values) {
    if (v.length > 0 && !isSealedValue(v) && out.includes(v)) {
      out = out.split(v).join(sealedHashToken(key, v));
    }
  }
  return out;
}

// The ext write trio nests its payload one level down (issue #298 item 9):
// `insert` carries secrets in `values`, `update` in `set`. Sealed columns
// there are per-table and dynamic, so redaction and scrub must look inside
// the container, keyed by the table's declared sealed list.
function extSecretContainer(commandName: string): 'values' | 'set' | null {
  if (/^ext\.[a-z0-9-]+\.insert$/.test(commandName)) return 'values';
  if (/^ext\.[a-z0-9-]+\.update$/.test(commandName)) return 'set';
  return null;
}

function extEntityOfInput(commandName: string, input: Record<string, unknown>): string | null {
  const appId = commandName.split('.')[1];
  const table = input['table'];
  if (!appId || typeof table !== 'string') return null;
  const prefix = input['band'] === 'draft' ? 'extdraft' : 'ext';
  return `${prefix}.${appId}.${table}`;
}

/**
 * Every plaintext secret string in a command's input — top-level declared
 * `sealedInput` for canonical commands, plus the nested sealed columns of the
 * ext trio's `values`/`set` payload. The one source of truth behind both the
 * journal redaction and the error-text scrub.
 */
export function sealedValuesForCommand(
  commandName: string,
  input: Record<string, unknown>,
  sealedInput: readonly string[],
  vault?: DatabaseSync,
): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.length > 0 && !isSealedValue(v)) out.push(v);
  };
  for (const p of sealedInput) push(input[p]);
  const container = extSecretContainer(commandName);
  if (container && vault) {
    const entity = extEntityOfInput(commandName, input);
    const payload = input[container];
    if (entity && payload && typeof payload === 'object') {
      for (const col of sealedColumnsOf(entity, vault)) {
        push((payload as Record<string, unknown>)[col]);
      }
    }
  }
  return out;
}

/**
 * Journal-safe copy of a command's input (issue #293 decision 4, extended for
 * the ext band in #298 item 9): declared secrets — top-level and nested in the
 * ext `values`/`set` container — become keyed hash tokens, never values.
 */
export function redactCommandInput(
  key: Buffer,
  commandName: string,
  input: Record<string, unknown>,
  sealedInput: readonly string[],
  vault?: DatabaseSync,
): Record<string, unknown> {
  let out = redactSealedInput(key, input, sealedInput);
  const container = extSecretContainer(commandName);
  if (container && vault) {
    const entity = extEntityOfInput(commandName, input);
    const payload = out[container];
    if (entity && payload && typeof payload === 'object') {
      const cols = sealedColumnsOf(entity, vault);
      if (cols.length > 0) {
        out = {
          ...out,
          [container]: redactSealedInput(key, payload as Record<string, unknown>, cols),
        };
      }
    }
  }
  return out;
}
